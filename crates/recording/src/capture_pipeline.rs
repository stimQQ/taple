use crate::{
    output_pipeline::*,
    sources::screen_capture::{self, CropBounds, ScreenCaptureFormat, ScreenCaptureTarget},
};
use anyhow::anyhow;
use cap_timestamp::Timestamps;
use std::path::PathBuf;

pub trait MakeCapturePipeline: ScreenCaptureFormat + std::fmt::Debug + 'static {
    async fn make_studio_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        output_path: PathBuf,
        start_time: Timestamps,
    ) -> anyhow::Result<OutputPipeline>
    where
        Self: Sized;
}

pub struct Stop;

impl MakeCapturePipeline for screen_capture::CMSampleBufferCapture {
    async fn make_studio_mode_pipeline(
        screen_capture: screen_capture::VideoSourceConfig,
        output_path: PathBuf,
        start_time: Timestamps,
    ) -> anyhow::Result<OutputPipeline> {
        OutputPipeline::builder(output_path.clone())
            .with_video::<screen_capture::VideoSource>(screen_capture)
            .with_timestamps(start_time)
            .build::<AVFoundationMp4Muxer>(Default::default())
            .await
    }
}

pub type ScreenCaptureMethod = screen_capture::CMSampleBufferCapture;

pub fn target_to_display_and_crop(
    target: &ScreenCaptureTarget,
) -> anyhow::Result<(scap_targets::Display, Option<CropBounds>)> {
    use scap_targets::{bounds::*, *};

    let display = target.display().unwrap_or_else(Display::primary);

    let crop_bounds = match target {
        ScreenCaptureTarget::Display { .. } => None,
        ScreenCaptureTarget::Window { id } => {
            let window = Window::from_id(id).ok_or_else(|| anyhow!("Window not found"))?;

            let raw_display_bounds = display
                .raw_handle()
                .logical_bounds()
                .ok_or_else(|| anyhow!("No display bounds"))?;
            let raw_window_bounds = window
                .raw_handle()
                .logical_bounds()
                .ok_or_else(|| anyhow!("No window bounds"))?;

            Some(LogicalBounds::new(
                LogicalPosition::new(
                    raw_window_bounds.position().x() - raw_display_bounds.position().x(),
                    raw_window_bounds.position().y() - raw_display_bounds.position().y(),
                ),
                raw_window_bounds.size(),
            ))
        }
        ScreenCaptureTarget::Area {
            bounds: relative_bounds,
            ..
        } => Some(*relative_bounds),
    };

    Ok((display, crop_bounds))
}
