mod screencapturekit;
pub use screencapturekit::*;

mod cpal;
pub use cpal::*;

pub trait AsFFmpeg {
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError>;
}
