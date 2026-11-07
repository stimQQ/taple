use anyhow::Result;
use ndarray::{Array2, Axis};

use crate::tract::{DfParams, DfTract, RuntimeParams};

pub(crate) const TARGET_SPEECH_DB: f32 = -24.0;
const MAX_INPUT_GAIN_DB: f32 = 40.0;

fn frame_levels(samples: &[f32], hop_size: usize) -> Vec<f32> {
    samples
        .chunks_exact(hop_size)
        .map(|frame| {
            let energy: f32 = frame.iter().map(|s| s * s).sum::<f32>() / hop_size as f32;
            energy.sqrt()
        })
        .collect()
}

fn loudest_level(levels: &[f32]) -> f32 {
    let mut sorted: Vec<f32> = levels.to_vec();
    sorted.sort_by(|a, b| b.total_cmp(a));
    let count = (sorted.len() / 20).max(1).min(sorted.len());
    sorted[..count].iter().sum::<f32>() / count as f32
}

pub(crate) fn input_normalization_gain(samples: &[f32], hop_size: usize, target_db: f32) -> f32 {
    let levels = frame_levels(samples, hop_size);
    if levels.is_empty() {
        return 1.0;
    }
    let level = loudest_level(&levels);
    if level <= 1e-6 {
        return 1.0;
    }
    let target = 10f32.powf(target_db / 20.0);
    (target / level).clamp(1.0, 10f32.powf(MAX_INPUT_GAIN_DB / 20.0))
}

pub(crate) fn speech_level_gain(noisy: &[f32], enhanced: &[f32], hop_size: usize) -> f32 {
    let noisy_levels = frame_levels(noisy, hop_size);
    let enhanced_levels = frame_levels(enhanced, hop_size);
    let mut order: Vec<usize> = (0..noisy_levels.len().min(enhanced_levels.len())).collect();
    if order.len() < 10 {
        return 1.0;
    }
    order.sort_by(|a, b| noisy_levels[*b].total_cmp(&noisy_levels[*a]));
    let loudest = &order[..(order.len() / 20).max(1)];
    let noisy_sum: f32 = loudest.iter().map(|i| noisy_levels[*i]).sum();
    let enhanced_sum: f32 = loudest.iter().map(|i| enhanced_levels[*i]).sum();
    if noisy_sum <= 1e-8 || enhanced_sum <= 1e-8 {
        return 1.0;
    }
    (noisy_sum / enhanced_sum).clamp(1.0, 2.0)
}

pub struct DfOffline {
    dfp: DfParams,
    rp: RuntimeParams,
    ready: Option<DfTract>,
}

impl DfOffline {
    pub fn new(dfp: DfParams, rp: &RuntimeParams) -> Result<Self> {
        let model = DfTract::new(dfp.clone(), rp)?;
        Ok(Self {
            dfp,
            rp: rp.clone(),
            ready: Some(model),
        })
    }

    pub fn process_audio(&mut self, noisy_mono: &[f32]) -> Result<Vec<f32>> {
        let mut model = match self.ready.take() {
            Some(model) => model,
            None => DfTract::new(self.dfp.clone(), &self.rp)?,
        };
        let hop_size = model.hop_size;
        let n_samples = noisy_mono.len();
        if n_samples < hop_size {
            return Ok(noisy_mono.to_vec());
        }

        let delay = model.fft_size - hop_size + model.lookahead * hop_size;
        let input_gain = input_normalization_gain(noisy_mono, hop_size, TARGET_SPEECH_DB);
        let padded_len = (n_samples + delay).div_ceil(hop_size) * hop_size;
        let mut padded: Vec<f32> = noisy_mono.iter().map(|s| s * input_gain).collect();
        padded.resize(padded_len, 0.0);

        let noisy = Array2::from_shape_vec((1, padded_len), padded)?;
        let mut enhanced = Array2::<f32>::zeros((1, padded_len));
        for (noisy_frame, enhanced_frame) in noisy
            .axis_chunks_iter(Axis(1), hop_size)
            .zip(enhanced.axis_chunks_iter_mut(Axis(1), hop_size))
        {
            model.process(noisy_frame, enhanced_frame)?;
        }

        let noisy = noisy.row(0);
        let enhanced = enhanced.row(0);
        let mut output: Vec<f32> = enhanced
            .iter()
            .skip(delay)
            .take(n_samples)
            .copied()
            .collect();
        let noisy: Vec<f32> = noisy.iter().take(n_samples).copied().collect();
        let gain = speech_level_gain(&noisy, &output, hop_size) / input_gain;
        for s in output.iter_mut() {
            *s *= gain;
        }
        Ok(output)
    }
}
