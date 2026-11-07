use crate::AudioData;

pub enum StereoMode {
    Stereo,
    MonoL,
    MonoR,
}

pub struct AudioRendererTrack<'a> {
    pub data: &'a AudioData,
    pub gain: f32,
    pub stereo_mode: StereoMode,
    pub offset: isize,
}

// Renders a combination of audio tracks into a single stereo buffer
pub fn render_audio(
    tracks: &[AudioRendererTrack],
    offset: usize,
    samples: usize,
    out_offset: usize,
    out: &mut [f32],
) -> usize {
    let samples = samples.min(
        tracks
            .iter()
            .flat_map(|t| (t.data.samples().len() / t.data.channels() as usize).checked_sub(offset))
            .max()
            .unwrap_or(0),
    );

    for i in 0..samples {
        let mut left = 0.0;
        let mut right = 0.0;

        for track in tracks {
            let i = i.wrapping_add_signed(track.offset);

            let data = track.data;
            let gain = gain_for_db(track.gain);

            if gain == f32::NEG_INFINITY {
                continue;
            }

            if data.channels() == 1 {
                if let Some(sample) = data.samples().get(offset + i) {
                    left += sample * gain;
                    right += sample * gain;
                }
            } else if data.channels() == 2 {
                let base_idx = offset * 2 + i * 2;
                let Some(l_sample) = data.samples().get(base_idx) else {
                    continue;
                };
                let Some(r_sample) = data.samples().get(base_idx + 1) else {
                    continue;
                };

                match track.stereo_mode {
                    StereoMode::Stereo => {
                        left += l_sample * gain;
                        right += r_sample * gain;
                    }
                    StereoMode::MonoL => {
                        left += l_sample * gain;
                        right += l_sample * gain;
                    }
                    StereoMode::MonoR => {
                        left += r_sample * gain;
                        right += r_sample * gain;
                    }
                }
            }
        }

        out[out_offset + i * 2] = left;
        out[out_offset + i * 2 + 1] = right;
    }

    samples
}

fn track_frame(track: &AudioRendererTrack, index: isize) -> (f32, f32) {
    let Ok(index) = usize::try_from(index) else {
        return (0.0, 0.0);
    };

    let samples = track.data.samples();
    match track.data.channels() {
        1 => samples
            .get(index)
            .map_or((0.0, 0.0), |sample| (*sample, *sample)),
        2 => {
            let (Some(left), Some(right)) = (samples.get(index * 2), samples.get(index * 2 + 1))
            else {
                return (0.0, 0.0);
            };

            match track.stereo_mode {
                StereoMode::Stereo => (*left, *right),
                StereoMode::MonoL => (*left, *left),
                StereoMode::MonoR => (*right, *right),
            }
        }
        _ => (0.0, 0.0),
    }
}

pub fn render_audio_at(tracks: &[AudioRendererTrack], position: f64) -> (f32, f32) {
    let base = position.floor();
    let fraction = (position - base) as f32;
    let index = base as isize;

    let mut left = 0.0;
    let mut right = 0.0;

    for track in tracks {
        let gain = gain_for_db(track.gain);

        if gain == f32::NEG_INFINITY {
            continue;
        }

        let (left_a, right_a) = track_frame(track, index + track.offset);
        let (left_b, right_b) = track_frame(track, index + track.offset + 1);

        left += (left_a + (left_b - left_a) * fraction) * gain;
        right += (right_a + (right_b - right_a) * fraction) * gain;
    }

    (left, right)
}

fn gain_for_db(db: f32) -> f32 {
    match db {
        // Fully mute when at minimum
        v if v <= -30.0 => f32::NEG_INFINITY,
        v => db_to_linear(v),
    }
}
fn db_to_linear(db: f32) -> f32 {
    10.0_f32.powf(db / 20.0)
}
