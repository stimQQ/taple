mod macos;
pub use macos::*;

pub trait CapturedFrameExt {
    /// Creates an ffmpeg video frame from the native frame.
    /// Only size, format, and data are set.
    fn as_ffmpeg(&self) -> Result<ffmpeg::frame::Video, AsFFmpegError>;
}
