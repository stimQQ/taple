use serde::{Deserialize, Serialize};
use specta::Type;

pub mod macos;
pub use macos::*;
use tracing::instrument;

#[derive(Debug, Serialize, Deserialize, Type, Default)]
#[repr(isize)]
pub enum HapticPattern {
    Alignment = 0,
    LevelChange = 1,
    #[default]
    Generic = 2,
}

#[derive(Debug, Serialize, Deserialize, Type, Default)]
#[repr(usize)]
pub enum HapticPerformanceTime {
    Default = 0,
    #[default]
    Now = 1,
    DrawCompleted = 2,
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub fn perform_haptic_feedback(
    _pattern: Option<HapticPattern>,
    _time: Option<HapticPerformanceTime>,
) -> Result<(), String> {
    unsafe {
        use objc2_app_kit::{
            NSHapticFeedbackManager, NSHapticFeedbackPattern, NSHapticFeedbackPerformanceTime,
            NSHapticFeedbackPerformer,
        };

        NSHapticFeedbackManager::defaultPerformer().performFeedbackPattern_performanceTime(
            NSHapticFeedbackPattern(_pattern.unwrap_or_default() as isize),
            NSHapticFeedbackPerformanceTime(_time.unwrap_or_default() as usize),
        );
        Ok(())
    }
}
