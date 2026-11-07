use std::path::Path;

use serde::Serialize;
use specta::Type;
use tracing::*;

use super::task_error;

#[derive(Serialize, Type, Debug, Clone)]
pub struct ActivityRegion {
    pub segment_index: u32,
    pub start: f64,
    pub end: f64,
    pub cursor_moving: bool,
    pub clicked: bool,
    pub screen_changing: bool,
}

#[derive(Serialize, Type, Debug, Clone)]
pub struct VisualActivity {
    pub resolution_ms: u32,
    pub regions: Vec<ActivityRegion>,
}

#[tauri::command]
#[specta::specta]
#[instrument]
pub async fn get_visual_activity(project_path: String) -> Result<VisualActivity, String> {
    let handle = tokio::runtime::Handle::current();

    tokio::task::spawn_blocking(move || analyze(Path::new(&project_path), handle))
        .await
        .map_err(task_error)?
}

#[cfg(not(target_os = "macos"))]
fn analyze(
    _project_path: &Path,
    _handle: tokio::runtime::Handle,
) -> Result<VisualActivity, String> {
    Err(crate::i18n::tr(
        "当前系统不支持屏幕分析",
        "Screen analysis is not supported on this platform",
    )
    .to_string())
}

#[cfg(target_os = "macos")]
use mac::analyze;

#[cfg(target_os = "macos")]
mod mac {
    use std::{
        collections::HashMap,
        path::{Path, PathBuf},
        sync::{LazyLock, Mutex, PoisonError},
        time::SystemTime,
    };

    use cap_project::{CursorEvents, StudioRecordingMeta};
    use cidre::objc;

    use super::{ActivityRegion, VisualActivity};
    use crate::ai::storyboard::mac::{FrameReader, SegmentSource, luma_thumbnail, segment_sources};
    use crate::ai::{click_position, load_meta, on_screen};

    const BIN_SECS: f64 = 0.1;
    const SCREEN_SAMPLE_SECS: f64 = 0.2;
    const CURSOR_MOVE_THRESHOLD: f64 = 0.003;
    const SCREEN_PIXEL_THRESHOLD: u8 = 16;
    const SCREEN_MIN_CHANGED_CELLS: usize = 2;
    const TICKER_WINDOW_SAMPLES: usize = 15;
    const TICKER_MIN_CHANGES: usize = 4;
    const LARGE_CHANGE_CELLS: usize = 48;
    const SMALL_CHANGE_CELLS: usize = 3;
    const ISOLATION_SAMPLES: usize = 5;
    const MAX_GAP_BINS: usize = 1;

    const CURSOR: u8 = 1;
    const CLICK: u8 = 2;
    const SCREEN: u8 = 4;

    type Fingerprint = Vec<(PathBuf, Option<SystemTime>, u64)>;

    static CACHE: LazyLock<Mutex<HashMap<PathBuf, (Fingerprint, VisualActivity)>>> =
        LazyLock::new(Default::default);

    struct SegmentInputs {
        source: SegmentSource,
        cursor: Option<PathBuf>,
        clock_offset: f64,
    }

    fn fingerprint(inputs: &[SegmentInputs]) -> Fingerprint {
        inputs
            .iter()
            .flat_map(|input| std::iter::once(&input.source.path).chain(input.cursor.as_ref()))
            .map(|path| {
                let metadata = std::fs::metadata(path).ok();
                (
                    path.clone(),
                    metadata.as_ref().and_then(|m| m.modified().ok()),
                    metadata.map_or(0, |m| m.len()),
                )
            })
            .collect()
    }

    fn segment_inputs(project_path: &Path) -> Result<Vec<SegmentInputs>, String> {
        let meta = load_meta(project_path)?;
        let sources = segment_sources(project_path)?;

        Ok(sources
            .into_iter()
            .map(|source| {
                let (cursor, clock_offset) = match meta.studio_meta() {
                    StudioRecordingMeta::SingleSegment { segment } => {
                        (segment.cursor.as_ref().map(|path| meta.path(path)), 0.0)
                    }
                    StudioRecordingMeta::MultipleSegments { inner } => inner
                        .segments
                        .get(source.index as usize)
                        .map_or((None, 0.0), |segment| {
                            (
                                segment.cursor.as_ref().map(|path| meta.path(path)),
                                segment.latest_start_time().unwrap_or(0.0),
                            )
                        }),
                };

                SegmentInputs {
                    source,
                    cursor,
                    clock_offset,
                }
            })
            .collect())
    }

    fn bin_index(time: f64, bins: usize) -> Option<usize> {
        if !(0.0..bins as f64 * BIN_SECS).contains(&time) {
            return None;
        }

        Some(((time / BIN_SECS).floor() as usize).min(bins - 1))
    }

    fn mark_cursor(flags: &mut [u8], cursor_path: &Path, clock_offset: f64) {
        let Ok(mut events) = CursorEvents::load_from_file(cursor_path) else {
            return;
        };

        events.moves.sort_by(|a, b| a.time_ms.total_cmp(&b.time_ms));

        let mut travelled = vec![0.0_f64; flags.len()];
        for pair in events.moves.windows(2) {
            if !on_screen(pair[0].x, pair[0].y) || !on_screen(pair[1].x, pair[1].y) {
                continue;
            }

            let time = pair[1].time_ms / 1000.0 - clock_offset;
            let Some(bin) = bin_index(time, flags.len()) else {
                continue;
            };

            travelled[bin] += (pair[1].x - pair[0].x).hypot(pair[1].y - pair[0].y);
        }

        for (flag, distance) in flags.iter_mut().zip(travelled) {
            if distance > CURSOR_MOVE_THRESHOLD {
                *flag |= CURSOR;
            }
        }

        for click in &events.clicks {
            if !click_position(&events.moves, click.time_ms).is_some_and(|(x, y)| on_screen(x, y)) {
                continue;
            }

            if let Some(bin) = bin_index(click.time_ms / 1000.0 - clock_offset, flags.len()) {
                flags[bin] |= CLICK;
            }
        }
    }

    struct ScreenSample {
        time: f64,
        changed: Vec<usize>,
    }

    fn changed_cell_indices(previous: &[u8], current: &[u8]) -> Vec<usize> {
        previous
            .iter()
            .zip(current)
            .enumerate()
            .filter(|(_, (a, b))| a.abs_diff(**b) > SCREEN_PIXEL_THRESHOLD)
            .map(|(index, _)| index)
            .collect()
    }

    fn sample_screen(
        source: &SegmentSource,
        handle: &tokio::runtime::Handle,
    ) -> Result<Vec<ScreenSample>, String> {
        let mut reader = FrameReader::new(source.path.clone(), handle.clone())?;
        let count = (source.duration / SCREEN_SAMPLE_SECS).floor() as usize + 1;
        let mut previous: Option<Vec<u8>> = None;
        let mut samples = Vec::with_capacity(count);

        for sample in 0..count {
            let time = sample as f64 * SCREEN_SAMPLE_SECS;

            let thumbnail = objc::ar_pool(|| -> Result<Option<Vec<u8>>, String> {
                Ok(reader
                    .frame_at(time + source.offset)?
                    .and_then(|frame| luma_thumbnail(&mut frame.image)))
            })?;

            let Some(thumbnail) = thumbnail else {
                continue;
            };

            if let Some(previous) = &previous {
                samples.push(ScreenSample {
                    time,
                    changed: changed_cell_indices(previous, &thumbnail),
                });
            }

            previous = Some(thumbnail);
        }

        Ok(samples)
    }

    fn content_changes(samples: &[ScreenSample]) -> Vec<bool> {
        let mut history: HashMap<usize, Vec<usize>> = HashMap::new();
        for (index, sample) in samples.iter().enumerate() {
            for cell in &sample.changed {
                history.entry(*cell).or_default().push(index);
            }
        }

        let repeating = |cell: usize, index: usize| {
            history.get(&cell).is_some_and(|indices| {
                let from = indices.partition_point(|i| i + TICKER_WINDOW_SAMPLES < index);
                let to = indices.partition_point(|i| *i <= index + TICKER_WINDOW_SAMPLES);
                to - from >= TICKER_MIN_CHANGES
            })
        };

        let content: Vec<usize> = samples
            .iter()
            .enumerate()
            .map(|(index, sample)| {
                sample
                    .changed
                    .iter()
                    .filter(|cell| !repeating(**cell, index))
                    .count()
            })
            .collect();

        samples
            .iter()
            .enumerate()
            .map(|(index, sample)| {
                if sample.changed.len() >= LARGE_CHANGE_CELLS {
                    return true;
                }

                let own = content[index];
                if own < SCREEN_MIN_CHANGED_CELLS {
                    return false;
                }

                if own > SMALL_CHANGE_CELLS {
                    return true;
                }

                let from = index.saturating_sub(ISOLATION_SAMPLES);
                let to = (index + ISOLATION_SAMPLES).min(samples.len() - 1);
                (from..=to).any(|i| i != index && content[i] >= SCREEN_MIN_CHANGED_CELLS)
            })
            .collect()
    }

    fn mark_screen(
        flags: &mut [u8],
        source: &SegmentSource,
        handle: &tokio::runtime::Handle,
    ) -> Result<(), String> {
        let samples = sample_screen(source, handle)?;

        for (sample, changed) in samples.iter().zip(content_changes(&samples)) {
            if !changed {
                continue;
            }

            let start = bin_index(sample.time - SCREEN_SAMPLE_SECS, flags.len()).unwrap_or(0);
            let end = bin_index(sample.time, flags.len()).unwrap_or(flags.len() - 1);
            for flag in &mut flags[start..end.max(start) + 1] {
                *flag |= SCREEN;
            }
        }

        Ok(())
    }

    fn round_to(value: f64, decimals: i32) -> f64 {
        let factor = 10f64.powi(decimals);
        (value * factor).round() / factor
    }

    fn regions_from_flags(segment_index: u32, flags: &[u8]) -> Vec<ActivityRegion> {
        let mut regions: Vec<(usize, usize, u8)> = Vec::new();

        for (bin, flag) in flags.iter().enumerate() {
            if *flag == 0 {
                continue;
            }

            if let Some(region) = regions.last_mut()
                && bin - region.1 <= MAX_GAP_BINS
            {
                region.1 = bin + 1;
                region.2 |= flag;
                continue;
            }

            regions.push((bin, bin + 1, *flag));
        }

        regions
            .into_iter()
            .map(|(start, end, flag)| ActivityRegion {
                segment_index,
                start: round_to(start as f64 * BIN_SECS, 1),
                end: round_to(end as f64 * BIN_SECS, 1),
                cursor_moving: flag & CURSOR != 0,
                clicked: flag & CLICK != 0,
                screen_changing: flag & SCREEN != 0,
            })
            .collect()
    }

    pub fn analyze(
        project_path: &Path,
        handle: tokio::runtime::Handle,
    ) -> Result<VisualActivity, String> {
        let inputs = segment_inputs(project_path)?;
        let key = fingerprint(&inputs);

        if let Some((cached_key, activity)) = CACHE
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(project_path)
            && *cached_key == key
        {
            return Ok(activity.clone());
        }

        let mut regions = Vec::new();
        for input in &inputs {
            let bins = ((input.source.duration / BIN_SECS).ceil() as usize).max(1);
            let mut flags = vec![0u8; bins];

            if let Some(cursor) = &input.cursor
                && cursor.exists()
            {
                mark_cursor(&mut flags, cursor, input.clock_offset);
            }

            mark_screen(&mut flags, &input.source, &handle)?;
            regions.extend(regions_from_flags(input.source.index, &flags));
        }

        let activity = VisualActivity {
            resolution_ms: (BIN_SECS * 1000.0) as u32,
            regions,
        };

        CACHE
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(project_path.to_path_buf(), (key, activity.clone()));

        Ok(activity)
    }

    #[cfg(test)]
    mod tests {
        use super::{ScreenSample, content_changes};

        fn samples(count: usize, changed: impl Fn(usize) -> Vec<usize>) -> Vec<ScreenSample> {
            (0..count)
                .map(|index| ScreenSample {
                    time: index as f64 * 0.2,
                    changed: changed(index),
                })
                .collect()
        }

        #[test]
        fn ignores_blinking_caret_and_ticking_counter() {
            let input = samples(100, |i| {
                let mut cells = Vec::new();
                if i % 3 == 0 {
                    cells.extend([10, 11]);
                }
                if i % 5 == 0 {
                    cells.extend([500, 501, 502]);
                }
                cells
            });
            assert!(content_changes(&input).iter().all(|changed| !changed));
        }

        #[test]
        fn ignores_isolated_small_change() {
            let input = samples(60, |i| if i == 30 { vec![900, 901] } else { vec![] });
            assert!(content_changes(&input).iter().all(|changed| !changed));
        }

        #[test]
        fn keeps_typing_next_to_a_blinking_caret() {
            let input = samples(100, |i| {
                let mut cells = Vec::new();
                if i % 3 == 0 {
                    cells.push(10);
                }
                if (40..60).contains(&i) && i % 2 == 0 {
                    cells.extend([2000 + i, 2001 + i]);
                }
                cells
            });
            let changes = content_changes(&input);
            assert!(changes[40] && changes[50] && changes[58]);
            assert!(!changes[3] && !changes[90]);
        }

        #[test]
        fn keeps_large_changes_even_when_repeating() {
            let input = samples(30, |_| (0..60).collect());
            assert!(content_changes(&input).iter().all(|changed| *changed));
        }

        #[test]
        fn keeps_a_single_large_change() {
            let input = samples(30, |i| {
                if i == 12 {
                    (100..120).collect()
                } else {
                    vec![]
                }
            });
            let changes = content_changes(&input);
            assert!(changes[12]);
            assert_eq!(changes.iter().filter(|c| **c).count(), 1);
        }
    }
}
