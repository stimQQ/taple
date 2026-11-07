use anyhow::{Context, Result};
use ort::session::Session;

use crate::offline::{input_normalization_gain, speech_level_gain, TARGET_SPEECH_DB};
use crate::tract::{DfParams, RuntimeParams};
use crate::*;

pub struct DfOrt {
    enc: Session,
    erb_dec: Session,
    df_dec: Session,
    pub sr: usize,
    pub hop_size: usize,
    pub fft_size: usize,
    pub nb_erb: usize,
    pub nb_df: usize,
    pub n_freqs: usize,
    pub df_order: usize,
    pub lookahead: usize,
    pub df_lookahead: usize,
    pub alpha: f32,
    pub min_db_thresh: f32,
    pub max_db_erb_thresh: f32,
    pub max_db_df_thresh: f32,
    pub atten_lim: Option<f32>,
    pub post_filter: bool,
    pub post_filter_beta: f32,
}

fn create_session(model_bytes: &[u8]) -> Result<Session> {
    Session::builder()
        .context("Failed to create ORT session builder")?
        .commit_from_memory(model_bytes)
        .context("Failed to load ONNX model into ORT session")
}

fn calc_norm_alpha(sr: usize, hop_size: usize, tau: f32) -> f32 {
    let dt = hop_size as f32 / sr as f32;
    let alpha = f32::exp(-dt / tau);
    let mut a = 1.0;
    let mut precision = 3;
    while a >= 1.0 {
        a = (alpha * 10i32.pow(precision) as f32).round() / 10i32.pow(precision) as f32;
        precision += 1;
    }
    a
}

impl DfOrt {
    pub fn new(dfp: DfParams, rp: &RuntimeParams) -> Result<Self> {
        let config = &dfp.config;
        let df_cfg = config.section(Some("df")).context("Missing [df] config section")?;
        let net_cfg = config
            .section(Some("deepfilternet"))
            .context("Missing [deepfilternet] config section")?;

        let sr = df_cfg.get("sr").unwrap().parse::<usize>()?;
        let hop_size = df_cfg.get("hop_size").unwrap().parse::<usize>()?;
        let fft_size = df_cfg.get("fft_size").unwrap().parse::<usize>()?;
        let nb_erb = df_cfg.get("nb_erb").unwrap().parse::<usize>()?;
        let nb_df = df_cfg.get("nb_df").unwrap().parse::<usize>()?;
        let df_order = df_cfg
            .get("df_order")
            .unwrap_or_else(|| net_cfg.get("df_order").unwrap())
            .parse::<usize>()?;
        let conv_lookahead = net_cfg.get("conv_lookahead").unwrap().parse::<usize>()?;
        let df_lookahead = df_cfg
            .get("df_lookahead")
            .unwrap_or_else(|| net_cfg.get("df_lookahead").unwrap())
            .parse::<usize>()?;
        let n_freqs = fft_size / 2 + 1;
        let alpha = if let Some(a) = df_cfg.get("norm_alpha") {
            a.parse::<f32>()?
        } else {
            let tau = df_cfg.get("norm_tau").unwrap().parse::<f32>()?;
            calc_norm_alpha(sr, hop_size, tau)
        };
        let lookahead = conv_lookahead.max(df_lookahead);

        let atten_lim_db = rp.atten_lim_db.abs();
        let atten_lim = if atten_lim_db >= 100. {
            None
        } else if atten_lim_db < 0.01 {
            Some(1.)
        } else {
            Some(10f32.powf(-atten_lim_db / 20.))
        };

        eprintln!(
            "[DfOrt] Creating ORT sessions (sr={}, hop={}, fft={}, nb_erb={}, nb_df={}, df_order={}, df_lookahead={})",
            sr, hop_size, fft_size, nb_erb, nb_df, df_order, df_lookahead
        );

        let enc = create_session(&dfp.enc)?;
        let erb_dec = create_session(&dfp.erb_dec)?;
        let df_dec = create_session(&dfp.df_dec)?;

        eprintln!("[DfOrt] ORT sessions created successfully");

        Ok(Self {
            enc,
            erb_dec,
            df_dec,
            sr,
            hop_size,
            fft_size,
            nb_erb,
            nb_df,
            n_freqs,
            df_order,
            lookahead,
            df_lookahead,
            alpha,
            min_db_thresh: rp.min_db_thresh,
            max_db_erb_thresh: rp.max_db_erb_thresh,
            max_db_df_thresh: rp.max_db_df_thresh,
            atten_lim,
            post_filter: rp.post_filter,
            post_filter_beta: rp.post_filter_beta,
        })
    }

    pub fn process_audio(&mut self, noisy_mono: &[f32]) -> Result<Vec<f32>> {
        let n_samples = noisy_mono.len();
        let hop_size = self.hop_size;
        let lookahead = self.lookahead;
        let delay = self.fft_size - hop_size;
        if n_samples < hop_size {
            return Ok(noisy_mono.to_vec());
        }

        let input_gain = input_normalization_gain(noisy_mono, hop_size, TARGET_SPEECH_DB);
        let padded_len =
            (n_samples + delay + (lookahead + 1) * hop_size).div_ceil(hop_size) * hop_size;
        let mut padded: Vec<f32> = noisy_mono.iter().map(|s| s * input_gain).collect();
        padded.resize(padded_len, 0.0);
        let noisy_mono = padded.as_slice();
        let n_frames = padded_len / hop_size;

        let nb_erb = self.nb_erb;
        let nb_df = self.nb_df;
        let n_freqs = self.n_freqs;
        let df_order = self.df_order;
        let df_lookahead = self.df_lookahead;
        let sr = self.sr;
        let fft_size = self.fft_size;
        let alpha = self.alpha;
        let min_db_thresh = self.min_db_thresh;
        let max_db_erb_thresh = self.max_db_erb_thresh;
        let max_db_df_thresh = self.max_db_df_thresh;
        let atten_lim = self.atten_lim;
        let do_post_filter = self.post_filter;
        let post_filter_beta = self.post_filter_beta;

        eprintln!("[DfOrt] Input: {} samples, {} frames", n_samples, n_frames);

        let mut state = DFState::new(sr, fft_size, hop_size, nb_erb, 2);
        state.init_norm_states(nb_df);

        let mut all_spec: Vec<Vec<Complex32>> = Vec::with_capacity(n_frames);
        let mut erb_feat_data = vec![0f32; n_frames * nb_erb];
        let mut cplx_feat_data = vec![0f32; 2 * n_frames * nb_df];

        for t in 0..n_frames {
            let frame_start = t * hop_size;
            let frame_end = frame_start + hop_size;
            let frame = &noisy_mono[frame_start..frame_end];

            let mut spec = vec![Complex32::default(); n_freqs];
            state.analysis(frame, &mut spec);

            let mut erb_feat = vec![0f32; nb_erb];
            state.feat_erb(&spec, alpha, &mut erb_feat);
            for (i, &v) in erb_feat.iter().enumerate() {
                erb_feat_data[t * nb_erb + i] = v;
            }

            let mut cplx_feat = vec![Complex32::default(); nb_df];
            state.feat_cplx(&spec[..nb_df], alpha, &mut cplx_feat);
            for (i, &c) in cplx_feat.iter().enumerate() {
                cplx_feat_data[t * nb_df + i] = c.re;
                cplx_feat_data[n_frames * nb_df + t * nb_df + i] = c.im;
            }

            all_spec.push(spec);
        }

        let erb_input = ort::value::Tensor::from_array((
            vec![1i64, 1, n_frames as i64, nb_erb as i64],
            erb_feat_data.into_boxed_slice(),
        ))
        .context("Failed to create ERB tensor")?;

        let cplx_input = ort::value::Tensor::from_array((
            vec![1i64, 2, n_frames as i64, nb_df as i64],
            cplx_feat_data.into_boxed_slice(),
        ))
        .context("Failed to create complex feature tensor")?;

        eprintln!("[DfOrt] Running encoder...");
        let enc_outputs = self.enc.run(ort::inputs![
            "feat_erb" => erb_input,
            "feat_spec" => cplx_input,
        ])?;

        let (lsnr_shape, lsnr_data) = enc_outputs["lsnr"]
            .try_extract_tensor::<f32>()
            .context("Failed to extract lsnr")?;
        let lsnr_flat: Vec<f32> = lsnr_data.to_vec();

        let lsnr_min = lsnr_flat.iter().cloned().fold(f32::INFINITY, f32::min);
        let lsnr_max = lsnr_flat.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let lsnr_mean = lsnr_flat.iter().sum::<f32>() / lsnr_flat.len() as f32;
        eprintln!("[DfOrt] lsnr shape={:?}: min={:.2}, max={:.2}, mean={:.2}",
            &*lsnr_shape, lsnr_min, lsnr_max, lsnr_mean);

        eprintln!("[DfOrt] Running ERB decoder...");
        let erb_dec_outputs = self.erb_dec.run(ort::inputs![
            "emb" => &enc_outputs["emb"],
            "e3" => &enc_outputs["e3"],
            "e2" => &enc_outputs["e2"],
            "e1" => &enc_outputs["e1"],
            "e0" => &enc_outputs["e0"],
        ])?;

        let (gains_shape, gains_data) = erb_dec_outputs[0]
            .try_extract_tensor::<f32>()
            .context("Failed to extract gains")?;
        let gains_flat: Vec<f32> = gains_data.to_vec();

        let gains_min = gains_flat.iter().cloned().fold(f32::INFINITY, f32::min);
        let gains_max = gains_flat.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        let gains_mean = gains_flat.iter().sum::<f32>() / gains_flat.len().max(1) as f32;
        eprintln!("[DfOrt] Gains shape={:?}: min={:.4}, max={:.4}, mean={:.4}",
            &*gains_shape, gains_min, gains_max, gains_mean);

        eprintln!("[DfOrt] Running DF decoder...");
        let df_dec_outputs = self.df_dec.run(ort::inputs![
            "emb" => &enc_outputs["emb"],
            "c0" => &enc_outputs["c0"],
        ])?;

        let (coefs_shape, coefs_data) = df_dec_outputs["coefs"]
            .try_extract_tensor::<f32>()
            .context("Failed to extract coefs")?;
        let coefs_flat: Vec<f32> = coefs_data.to_vec();

        eprintln!("[DfOrt] Coefs shape={:?}, total_elements={}",
            &*coefs_shape, coefs_flat.len());

        drop(enc_outputs);
        drop(erb_dec_outputs);
        drop(df_dec_outputs);

        let erb_fb = erb_fb(sr, fft_size, nb_erb, 2);
        let mut synth_state = DFState::new(sr, fft_size, hop_size, nb_erb, 2);

        let out_frames = n_frames - lookahead;
        let mut output = vec![0f32; out_frames * hop_size];

        let gains_per_frame = nb_erb;
        let coefs_per_frame = nb_df * df_order * 2;
        let m_zeros = vec![0f32; nb_erb];
        let df_left_pad = (df_order - 1 - df_lookahead) as isize;

        let mut erb_count = 0usize;
        let mut df_count = 0usize;
        let mut zero_count = 0usize;
        let mut skip_count = 0usize;

        for t in 0..out_frames {
            let o = t + lookahead;
            let lsnr = lsnr_flat.get(o).copied().unwrap_or(0.0);

            let (apply_gains, apply_zero_mask, apply_df) = if lsnr < min_db_thresh {
                (false, true, false)
            } else if lsnr > max_db_erb_thresh {
                (false, false, false)
            } else if lsnr > max_db_df_thresh {
                (true, false, false)
            } else {
                (true, false, true)
            };

            let mut spec = all_spec[t].clone();

            if apply_gains {
                let gains_offset = o * gains_per_frame;
                if gains_offset + gains_per_frame <= gains_flat.len() {
                    apply_interp_band_gain(
                        &mut spec,
                        &gains_flat[gains_offset..gains_offset + gains_per_frame],
                        &erb_fb,
                    );
                }
                erb_count += 1;
            } else if apply_zero_mask {
                apply_interp_band_gain(&mut spec, &m_zeros, &erb_fb);
                zero_count += 1;
            } else {
                skip_count += 1;
            }

            if apply_df {
                let offset = o * coefs_per_frame;
                if offset + coefs_per_frame <= coefs_flat.len() {
                    for f in 0..nb_df {
                        let mut acc = Complex32::new(0.0, 0.0);
                        for k in 0..df_order {
                            let src_t = t as isize - df_left_pad + k as isize;
                            if src_t >= 0 && (src_t as usize) < n_frames {
                                let noisy_spec = all_spec[src_t as usize][f];
                                let coef_idx = offset + f * df_order * 2 + k * 2;
                                let coef_re = coefs_flat[coef_idx];
                                let coef_im = coefs_flat[coef_idx + 1];
                                acc += noisy_spec * Complex32::new(coef_re, coef_im);
                            }
                        }
                        spec[f] = acc;
                    }
                    df_count += 1;
                }
            }

            if do_post_filter && (apply_gains || apply_df) {
                let noisy_spec = &all_spec[t];
                post_filter(noisy_spec, &mut spec, post_filter_beta);
            }

            if let Some(lim) = atten_lim {
                let noisy_spec = &all_spec[t];
                for (enh, nsy) in spec.iter_mut().zip(noisy_spec.iter()) {
                    *enh = *enh * (1.0 - lim) + *nsy * lim;
                }
            }

            let out_frame = &mut output[t * hop_size..(t + 1) * hop_size];
            synth_state.synthesis(&mut spec, out_frame);
        }

        let mut output = output[delay..delay + n_samples].to_vec();
        let gain = speech_level_gain(&padded[..n_samples], &output, hop_size) / input_gain;
        for s in output.iter_mut() {
            *s *= gain;
        }

        eprintln!(
            "[DfOrt] Done: {} frames (ERB={}, DF={}, zero_mask={}, skip={}), input gain {:.1} dB, output gain {:.2}x",
            out_frames,
            erb_count,
            df_count,
            zero_count,
            skip_count,
            20.0 * input_gain.log10(),
            gain
        );

        Ok(output)
    }
}
