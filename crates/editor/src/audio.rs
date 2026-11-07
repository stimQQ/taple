use cap_audio::{
    AudioData, AudioRendererTrack, FromSampleBytes, StereoMode, cast_f32_slice_to_bytes,
    render_audio, render_audio_at,
};
use cap_media::MediaError;
use cap_media_info::AudioInfo;
use cap_project::{AudioConfiguration, AudioMuteRange, ClipOffsets, ProjectConfiguration};
use ffmpeg::{ChannelLayout, format as avformat, frame::Audio as FFAudio, software::resampling};
use ringbuf::{
    HeapRb,
    traits::{Consumer, Observer, Producer},
};
use std::sync::Arc;

const CUT_FADE_SECS: f64 = 0.02;
const MUTE_FADE_SECS: f64 = 0.015;
const CONTIGUOUS_EPSILON_SECS: f64 = 0.001;

pub struct AudioRenderer {
    data: Vec<AudioSegment>,
    elapsed_samples: usize,
}

#[derive(Clone)]
pub struct AudioSegment {
    pub tracks: Vec<AudioSegmentTrack>,
}

#[derive(Clone)]
pub struct AudioSegmentTrack {
    data: Arc<AudioData>,
    start_offset: f64,
    get_gain: fn(&AudioConfiguration) -> f32,
    get_stereo_mode: fn(&AudioConfiguration) -> StereoMode,
    get_offset: fn(&ClipOffsets) -> f32,
}

impl AudioSegmentTrack {
    pub fn new(
        data: Arc<AudioData>,
        start_offset: f64,
        get_gain: fn(&AudioConfiguration) -> f32,
        get_stereo_mode: fn(&AudioConfiguration) -> StereoMode,
        get_offset: fn(&ClipOffsets) -> f32,
    ) -> Self {
        Self {
            data,
            start_offset,
            get_gain,
            get_stereo_mode,
            get_offset,
        }
    }

    pub fn data(&self) -> &Arc<AudioData> {
        &self.data
    }

    pub fn gain(&self, config: &AudioConfiguration) -> f32 {
        (self.get_gain)(config)
    }

    pub fn stereo_mode(&self, config: &AudioConfiguration) -> StereoMode {
        (self.get_stereo_mode)(config)
    }

    pub fn offset(&self, offsets: &ClipOffsets) -> f32 {
        (self.get_offset)(offsets)
    }

    fn duration(&self) -> f64 {
        (self.data.sample_count() as f64 / f64::from(AudioData::SAMPLE_RATE) - self.start_offset)
            .max(0.0)
    }
}

struct TimelinePiece {
    recording_segment: u32,
    start: f64,
    timescale: f64,
    first_sample: usize,
    end_sample: usize,
    fade_in: bool,
    fade_out: bool,
}

impl TimelinePiece {
    fn source_time(&self, output_sample: usize) -> f64 {
        self.start
            + (output_sample - self.first_sample) as f64 / f64::from(AudioData::SAMPLE_RATE)
                * self.timescale
    }
}

fn seconds_to_samples(seconds: f64) -> usize {
    (seconds.max(0.0) * f64::from(AudioData::SAMPLE_RATE)).round() as usize
}

fn mute_gain(ranges: &[&AudioMuteRange], source_time: f64) -> f32 {
    ranges
        .iter()
        .filter(|range| source_time >= range.start && source_time <= range.end)
        .map(|range| {
            let depth = (source_time - range.start).min(range.end - source_time);
            1.0 - (depth / MUTE_FADE_SECS).min(1.0) as f32
        })
        .fold(1.0, f32::min)
}

impl AudioRenderer {
    pub const SAMPLE_FORMAT: avformat::Sample = AudioData::SAMPLE_FORMAT;
    pub const SAMPLE_RATE: u32 = AudioData::SAMPLE_RATE;
    pub const CHANNELS: u16 = 2;

    pub fn info() -> AudioInfo {
        AudioInfo::new(Self::SAMPLE_FORMAT, Self::SAMPLE_RATE, Self::CHANNELS).unwrap()
    }

    pub fn new(data: Vec<AudioSegment>) -> Self {
        Self {
            data,
            elapsed_samples: 0,
        }
    }

    pub fn set_playhead(&mut self, playhead: f64, _project: &ProjectConfiguration) {
        self.elapsed_samples = self.playhead_to_samples(playhead);
    }

    fn playhead_to_samples(&self, playhead: f64) -> usize {
        (playhead * AudioData::SAMPLE_RATE as f64) as usize
    }

    pub fn elapsed_samples_to_playhead(&self) -> f64 {
        self.elapsed_samples as f64 / AudioData::SAMPLE_RATE as f64
    }

    fn timeline_pieces(&self, project: &ProjectConfiguration) -> Vec<TimelinePiece> {
        let segments = project
            .timeline
            .as_ref()
            .map(|timeline| timeline.segments.as_slice())
            .unwrap_or_default();

        if segments.is_empty() {
            let duration = self
                .data
                .first()
                .and_then(|segment| {
                    segment
                        .tracks
                        .iter()
                        .map(AudioSegmentTrack::duration)
                        .reduce(f64::max)
                })
                .unwrap_or(0.0);

            return vec![TimelinePiece {
                recording_segment: 0,
                start: 0.0,
                timescale: 1.0,
                first_sample: 0,
                end_sample: seconds_to_samples(duration),
                fade_in: false,
                fade_out: false,
            }];
        }

        let mut pieces = Vec::with_capacity(segments.len());
        let mut output_time = 0.0;

        for (index, segment) in segments.iter().enumerate() {
            let duration = segment.duration();
            if duration.is_nan() || duration <= 0.0 {
                continue;
            }

            let previous = index.checked_sub(1).and_then(|i| segments.get(i));
            let next = segments.get(index + 1);
            let joins = |a: &cap_project::TimelineSegment, b: &cap_project::TimelineSegment| {
                a.recording_segment == b.recording_segment
                    && (a.end - b.start).abs() < CONTIGUOUS_EPSILON_SECS
                    && (a.timescale - b.timescale).abs() < f64::EPSILON
            };

            let first_sample = seconds_to_samples(output_time);
            output_time += duration;

            pieces.push(TimelinePiece {
                recording_segment: segment.recording_segment,
                start: segment.start,
                timescale: segment.timescale,
                first_sample,
                end_sample: seconds_to_samples(output_time),
                fade_in: previous.map_or(segment.start > CONTIGUOUS_EPSILON_SECS, |previous| {
                    !joins(previous, segment)
                }),
                fade_out: next.is_none_or(|next| !joins(segment, next)),
            });
        }

        pieces
    }

    pub fn render_frame(
        &mut self,
        requested_samples: usize,
        project: &ProjectConfiguration,
    ) -> Option<FFAudio> {
        self.render_frame_raw(requested_samples, project)
            .map(move |(samples, data)| {
                let mut raw_frame =
                    FFAudio::new(AudioData::SAMPLE_FORMAT, samples, ChannelLayout::STEREO);
                raw_frame.set_rate(AudioData::SAMPLE_RATE);
                raw_frame.data_mut(0)[0..data.len() * f32::BYTE_SIZE]
                    .copy_from_slice(unsafe { cast_f32_slice_to_bytes(&data) });

                raw_frame
            })
    }

    pub fn render_frame_raw(
        &mut self,
        samples: usize,
        project: &ProjectConfiguration,
    ) -> Option<(usize, Vec<f32>)> {
        if self.data.iter().all(|segment| segment.tracks.is_empty()) {
            self.elapsed_samples += samples;
            return None;
        }

        let pieces = self.timeline_pieces(project);
        let total_samples = pieces.last().map_or(0, |piece| piece.end_sample);

        if self.elapsed_samples >= total_samples {
            return None;
        }

        let count = samples.min(total_samples - self.elapsed_samples);
        let mut out = vec![0.0; count * 2];
        let fade_samples = CUT_FADE_SECS * f64::from(AudioData::SAMPLE_RATE);
        let mut position = 0;

        while position < count {
            let output_sample = self.elapsed_samples + position;
            let Some(piece) = pieces.iter().find(|piece| {
                output_sample >= piece.first_sample && output_sample < piece.end_sample
            }) else {
                position += 1;
                continue;
            };

            let chunk = (count - position).min(piece.end_sample - output_sample);
            let Some(segment) = self.data.get(piece.recording_segment as usize) else {
                position += chunk;
                continue;
            };

            let offsets = project
                .clips
                .iter()
                .find(|clip| clip.index == piece.recording_segment)
                .map(|clip| clip.offsets)
                .unwrap_or_default();

            let tracks = segment
                .tracks
                .iter()
                .map(|track| AudioRendererTrack {
                    data: track.data().as_ref(),
                    gain: if project.audio.mute {
                        f32::NEG_INFINITY
                    } else {
                        let gain = track.gain(&project.audio);
                        if gain < -30.0 {
                            f32::NEG_INFINITY
                        } else {
                            gain
                        }
                    },
                    stereo_mode: track.stereo_mode(&project.audio),
                    offset: ((f64::from(track.offset(&offsets)) + track.start_offset)
                        * f64::from(Self::SAMPLE_RATE))
                    .round() as isize,
                })
                .collect::<Vec<_>>();

            let rate = f64::from(Self::SAMPLE_RATE);
            let output = &mut out[position * 2..(position + chunk) * 2];

            if (piece.timescale - 1.0).abs() < f64::EPSILON {
                let source_start = seconds_to_samples(piece.source_time(output_sample));
                render_audio(&tracks, source_start, chunk, 0, output);
            } else {
                for (index, frame) in output.as_chunks_mut::<2>().0.iter_mut().enumerate() {
                    let (left, right) =
                        render_audio_at(&tracks, piece.source_time(output_sample + index) * rate);
                    frame[0] = left;
                    frame[1] = right;
                }
            }

            let span_start = piece.source_time(output_sample);
            let span_end = piece.source_time(output_sample + chunk);
            let mute_ranges: Vec<&AudioMuteRange> = project
                .audio
                .mute_ranges
                .iter()
                .filter(|range| {
                    range.recording_segment == piece.recording_segment
                        && range.end > range.start
                        && range.end >= span_start
                        && range.start <= span_end
                })
                .collect();

            let fades_here = (piece.fade_in
                && output_sample < piece.first_sample + fade_samples as usize)
                || (piece.fade_out
                    && output_sample + chunk + fade_samples as usize > piece.end_sample);

            if fades_here || !mute_ranges.is_empty() {
                for (index, frame) in output.as_chunks_mut::<2>().0.iter_mut().enumerate() {
                    let sample = output_sample + index;
                    let mut gain = 1.0_f64;

                    if piece.fade_in {
                        gain = gain.min((sample - piece.first_sample) as f64 / fade_samples);
                    }

                    if piece.fade_out {
                        gain = gain.min((piece.end_sample - sample) as f64 / fade_samples);
                    }

                    let gain = (gain.clamp(0.0, 1.0) as f32)
                        * mute_gain(&mute_ranges, piece.source_time(sample));

                    if gain < 1.0 {
                        frame[0] *= gain;
                        frame[1] *= gain;
                    }
                }
            }

            position += chunk;
        }

        self.elapsed_samples += count;
        soft_limit(&mut out);

        Some((count, out))
    }
}

const LIMIT_THRESHOLD: f32 = 0.891_250_9;
const LIMIT_CEILING: f32 = 0.995;

fn soft_limit(samples: &mut [f32]) {
    let headroom = LIMIT_CEILING - LIMIT_THRESHOLD;
    for sample in samples.iter_mut() {
        let magnitude = sample.abs();
        if magnitude > LIMIT_THRESHOLD {
            let limited =
                LIMIT_THRESHOLD + headroom * ((magnitude - LIMIT_THRESHOLD) / headroom).tanh();
            *sample = limited.copysign(*sample);
        }
    }
}

pub struct AudioPlaybackBuffer<T: FromSampleBytes> {
    frame_buffer: AudioRenderer,
    resampler: AudioResampler,
    resampled_buffer: HeapRb<T>,
}

impl<T: FromSampleBytes> AudioPlaybackBuffer<T> {
    pub const PLAYBACK_SAMPLES_COUNT: u32 = 256;
    pub const WIRELESS_PLAYBACK_SAMPLES_COUNT: u32 = 1024;
    const PROCESSING_SAMPLES_COUNT: u32 = 1024;

    pub fn new(data: Vec<AudioSegment>, output_info: AudioInfo) -> Self {
        // println!("Input info: {:?}", data[0][0].info);
        println!("Output info: {output_info:?}");

        let resampler = AudioResampler::new(output_info).unwrap();

        // Up to 1 second of pre-rendered audio
        let capacity = (output_info.sample_rate as usize)
            * output_info.channels
            * output_info.sample_format.bytes();
        let resampled_buffer = HeapRb::new(capacity);

        let frame_buffer = AudioRenderer::new(data);

        Self {
            frame_buffer,
            resampler,
            resampled_buffer,
        }
    }

    pub fn set_playhead(&mut self, playhead: f64, project: &ProjectConfiguration) {
        self.resampler.reset();
        self.resampled_buffer.clear();
        self.frame_buffer.set_playhead(playhead, project);
    }

    pub fn buffer_reaching_limit(&self) -> bool {
        self.resampled_buffer.vacant_len()
            <= 2 * (Self::PROCESSING_SAMPLES_COUNT as usize) * self.resampler.output.channels
    }

    fn render_chunk(&mut self, project: &ProjectConfiguration) -> bool {
        if self.buffer_reaching_limit() {
            return false;
        }

        let bytes_per_sample = self.resampler.output.sample_size();

        let next_frame = self
            .frame_buffer
            .render_frame(Self::PROCESSING_SAMPLES_COUNT as usize, project);

        let maybe_rendered = match next_frame {
            Some(frame) => Some(self.resampler.queue_and_process_frame(&frame)),
            None => self.resampler.flush_frame(),
        };

        let Some(rendered) = maybe_rendered else {
            return false;
        };

        if rendered.is_empty() {
            return false;
        }

        let mut typed_data = vec![T::EQUILIBRIUM; rendered.len() / bytes_per_sample];

        for (src, dest) in std::iter::zip(rendered.chunks(bytes_per_sample), &mut typed_data) {
            *dest = T::from_bytes(src);
        }
        self.resampled_buffer.push_slice(&typed_data);
        true
    }

    pub fn prefill(&mut self, project: &ProjectConfiguration, min_samples: usize) {
        if min_samples == 0 {
            return;
        }

        let capacity = self.resampled_buffer.capacity().get();
        let target = min_samples.min(capacity);

        while self.resampled_buffer.occupied_len() < target {
            if !self.render_chunk(project) {
                break;
            }
        }
    }

    pub fn fill(
        &mut self,
        playback_buffer: &mut [T],
        project: &ProjectConfiguration,
        min_headroom_samples: usize,
    ) {
        self.prefill(project, min_headroom_samples.max(playback_buffer.len()));

        let filled = self.resampled_buffer.pop_slice(playback_buffer);
        playback_buffer[filled..].fill(T::EQUILIBRIUM);

        self.prefill(project, min_headroom_samples);
    }
}

pub struct AudioResampler {
    pub context: resampling::Context,
    pub output_frame: FFAudio,
    delay: Option<resampling::Delay>,
    output: AudioInfo,
}

impl AudioResampler {
    pub fn new(output_info: AudioInfo) -> Result<Self, MediaError> {
        let context = ffmpeg::software::resampler(
            (
                AudioData::SAMPLE_FORMAT,
                ChannelLayout::STEREO,
                AudioData::SAMPLE_RATE,
            ),
            (
                output_info.sample_format,
                output_info.channel_layout(),
                output_info.sample_rate,
            ),
        )?;

        Ok(Self {
            output: output_info,
            context,
            output_frame: FFAudio::empty(),
            delay: None,
        })
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.output).unwrap();
    }

    fn current_frame_data(&self) -> &[u8] {
        let end = self.output_frame.samples() * self.output.channels * self.output.sample_size();
        &self.output_frame.data(0)[0..end]
    }

    pub fn queue_and_process_frame<'a>(&'a mut self, frame: &FFAudio) -> &'a [u8] {
        self.delay = self.context.run(frame, &mut self.output_frame).unwrap();

        // Teeechnically this doesn't work for planar output
        self.current_frame_data()
    }

    pub fn flush_frame(&mut self) -> Option<&[u8]> {
        self.delay?;

        self.delay = self.context.flush(&mut self.output_frame).unwrap();

        Some(self.current_frame_data())
    }
}

#[cfg(test)]
mod limiter_tests {
    use super::{LIMIT_THRESHOLD, soft_limit};

    #[test]
    fn leaves_normal_levels_untouched() {
        let mut samples = [0.0, 0.25, -0.5, 0.89, -0.89];
        let original = samples;
        soft_limit(&mut samples);
        assert_eq!(samples, original);
    }

    #[test]
    fn keeps_loud_peaks_below_full_scale() {
        let mut samples = [0.95, -1.2, 2.0, -8.0, 30.0];
        soft_limit(&mut samples);
        for (limited, raw) in samples.iter().zip([0.95_f32, -1.2, 2.0, -8.0, 30.0]) {
            assert!(limited.abs() < 1.0);
            assert!(limited.abs() > LIMIT_THRESHOLD);
            assert_eq!(limited.signum(), raw.signum());
        }
        assert!(samples[0] < samples[2]);
        assert!(samples[2] <= samples[4]);
    }
}
