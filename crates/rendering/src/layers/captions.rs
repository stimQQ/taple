use std::{
    collections::HashSet,
    f32::consts::TAU,
    path::PathBuf,
    sync::{PoisonError, RwLock},
    time::SystemTime,
};

use cap_project::XY;
use glyphon::{
    Attrs, Buffer, Cache, Color, ContentType, CustomGlyph, Family, FontSystem, Metrics,
    RasterizedCustomGlyph, Resolution, Shaping, Style, SwashCache, TextArea, TextAtlas, TextBounds,
    TextRenderer, Viewport, Weight, Wrap, cosmic_text::Align, fontdb,
};
use log::warn;
use wgpu::{Device, Queue};

use crate::{DecodedSegmentFrames, ProjectUniforms, RenderVideoConstants, parse_color_component};

const REFERENCE_HEIGHT: f32 = 1080.0;
const MAX_WIDTH_RATIO: f32 = 0.86;
const EDGE_MARGIN_RATIO: f32 = 0.07;
const LINE_HEIGHT_EM: f32 = 1.25;
const OUTLINE_EM: f32 = 0.08;
const BOX_PADDING_X_EM: f32 = 0.45;
const BOX_PADDING_Y_EM: f32 = 0.2;
const BOX_RADIUS_RATIO: f32 = 0.22;

static CAPTION_FONT_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

pub fn set_caption_font_dir(dir: PathBuf) {
    *CAPTION_FONT_DIR
        .write()
        .unwrap_or_else(PoisonError::into_inner) = Some(dir);
}

fn caption_font_dir() -> Option<PathBuf> {
    CAPTION_FONT_DIR
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

const SYSTEM_SANS: &[&str] = &[
    "PingFang SC",
    "Hiragino Sans GB",
    "Heiti SC",
    "Microsoft YaHei",
    "Noto Sans CJK SC",
];
const SYSTEM_SERIF: &[&str] = &["Songti SC", "STSong", "SimSun", "Noto Serif CJK SC"];
const SYSTEM_MONO: &[&str] = &["Menlo", "SF Mono", "Consolas", "DejaVu Sans Mono"];

struct FaceChoice {
    family: String,
    weight: Weight,
    style: Style,
    stretch: fontdb::Stretch,
}

#[derive(PartialEq, Clone)]
struct LayoutKey {
    text: String,
    font: String,
    bold: bool,
    italic: bool,
    font_size: u32,
    width: u32,
}

pub struct CaptionsLayer {
    font_system: FontSystem,
    swash_cache: SwashCache,
    text_atlas: TextAtlas,
    text_renderer: TextRenderer,
    text_buffer: Buffer,
    empty_buffer: Buffer,
    viewport: Viewport,
    layout_key: Option<LayoutKey>,
    loaded_fonts: HashSet<PathBuf>,
    font_dir_stamp: Option<SystemTime>,
}

impl CaptionsLayer {
    pub fn new(device: &Device, queue: &Queue) -> Self {
        let font_system = FontSystem::new();
        let swash_cache = SwashCache::new();
        let cache = Cache::new(device);
        let viewport = Viewport::new(device, &cache);
        let mut text_atlas =
            TextAtlas::new(device, queue, &cache, wgpu::TextureFormat::Rgba8UnormSrgb);
        let text_renderer = TextRenderer::new(
            &mut text_atlas,
            device,
            wgpu::MultisampleState::default(),
            None,
        );
        let metrics = Metrics::new(24.0, 24.0 * LINE_HEIGHT_EM);

        Self {
            font_system,
            swash_cache,
            text_atlas,
            text_renderer,
            text_buffer: Buffer::new_empty(metrics),
            empty_buffer: Buffer::new_empty(metrics),
            viewport,
            layout_key: None,
            loaded_fonts: HashSet::new(),
            font_dir_stamp: None,
        }
    }

    fn refresh_fonts(&mut self) {
        let Some(dir) = caption_font_dir() else {
            return;
        };

        let stamp = std::fs::metadata(&dir)
            .and_then(|metadata| metadata.modified())
            .ok();
        if stamp.is_none() || stamp == self.font_dir_stamp {
            return;
        }
        self.font_dir_stamp = stamp;

        let Ok(entries) = std::fs::read_dir(&dir) else {
            return;
        };

        let mut added = false;
        for path in entries.flatten().map(|entry| entry.path()) {
            let is_font = path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("ttf") || extension.eq_ignore_ascii_case("otf")
                });
            if !is_font || self.loaded_fonts.contains(&path) {
                continue;
            }

            match self.font_system.db_mut().load_font_file(&path) {
                Ok(()) => {
                    self.loaded_fonts.insert(path);
                    added = true;
                }
                Err(e) => warn!("Failed to load caption font {}: {e}", path.display()),
            }
        }

        if added {
            self.layout_key = None;
        }
    }

    fn resolve_face(&self, family: &str, bold: bool, italic: bool) -> Option<FaceChoice> {
        let faces: Vec<&fontdb::FaceInfo> = self
            .font_system
            .db()
            .faces()
            .filter(|face| {
                face.families
                    .iter()
                    .any(|(name, _)| name.eq_ignore_ascii_case(family))
            })
            .collect();

        let has_italic = faces.iter().any(|face| face.style != Style::Normal);
        let want_italic = italic && has_italic;
        let target = if bold { 700 } else { 400 };

        faces
            .into_iter()
            .filter(|face| (face.style != Style::Normal) == want_italic)
            .min_by_key(|face| {
                let heavier_first = if bold {
                    u16::MAX - face.weight.0
                } else {
                    face.weight.0
                };
                (face.weight.0.abs_diff(target), heavier_first)
            })
            .map(|face| FaceChoice {
                family: face
                    .families
                    .iter()
                    .find(|(name, _)| name.eq_ignore_ascii_case(family))
                    .map_or_else(|| family.to_string(), |(name, _)| name.clone()),
                weight: face.weight,
                style: face.style,
                stretch: face.stretch,
            })
    }

    fn choose_face(&self, font: &str, bold: bool, italic: bool) -> Option<FaceChoice> {
        let candidates: &[&str] = match font {
            "" | "System Sans-Serif" => SYSTEM_SANS,
            "System Serif" => SYSTEM_SERIF,
            "System Monospace" => SYSTEM_MONO,
            name => &[name],
        };

        candidates
            .iter()
            .find_map(|family| self.resolve_face(family, bold, italic))
    }

    fn layout(&mut self, key: LayoutKey) {
        if self.layout_key.as_ref() == Some(&key) {
            return;
        }

        let font_size = key.font_size as f32 / 10.0;
        let metrics = Metrics::new(font_size, font_size * LINE_HEIGHT_EM);
        let mut buffer = Buffer::new(&mut self.font_system, metrics);
        buffer.set_size(&mut self.font_system, Some(key.width as f32), None);
        buffer.set_wrap(&mut self.font_system, Wrap::WordOrGlyph);

        let choice = self.choose_face(&key.font, key.bold, key.italic);
        let attrs = match &choice {
            Some(choice) => Attrs::new()
                .family(Family::Name(&choice.family))
                .weight(choice.weight)
                .style(choice.style)
                .stretch(choice.stretch),
            None => Attrs::new()
                .family(match key.font.as_str() {
                    "System Serif" => Family::Serif,
                    "System Monospace" => Family::Monospace,
                    _ => Family::SansSerif,
                })
                .weight(if key.bold {
                    Weight::BOLD
                } else {
                    Weight::NORMAL
                })
                .style(if key.italic {
                    Style::Italic
                } else {
                    Style::Normal
                }),
        };

        buffer.set_text(&mut self.font_system, &key.text, &attrs, Shaping::Advanced);
        for line in buffer.lines.iter_mut() {
            line.set_align(Some(Align::Center));
        }
        buffer.shape_until_scroll(&mut self.font_system, false);

        self.text_buffer = buffer;
        self.layout_key = Some(key);
    }

    fn block_size(&self) -> (f32, f32) {
        self.text_buffer
            .layout_runs()
            .fold((0.0_f32, 0.0_f32), |(width, height), run| {
                (
                    width.max(run.line_w),
                    height.max(run.line_top + run.line_height),
                )
            })
    }

    fn clear(&mut self, device: &Device, queue: &Queue) {
        if let Err(e) = self.text_renderer.prepare(
            device,
            queue,
            &mut self.font_system,
            &mut self.text_atlas,
            &self.viewport,
            std::iter::empty::<TextArea>(),
            &mut self.swash_cache,
        ) {
            warn!("Error clearing captions: {e:?}");
        }
    }

    pub fn prepare(
        &mut self,
        uniforms: &ProjectUniforms,
        segment_frames: &DecodedSegmentFrames,
        output_size: XY<u32>,
        constants: &RenderVideoConstants,
    ) {
        let device = &constants.device;
        let queue = &constants.queue;
        self.text_atlas.trim();

        let Some(caption_data) = uniforms
            .project
            .captions
            .as_ref()
            .filter(|captions| captions.settings.enabled)
        else {
            self.clear(device, queue);
            return;
        };

        let Some(caption) =
            find_caption_at_time_project(segment_frames.segment_time, &caption_data.segments)
                .filter(|caption| !caption.text.trim().is_empty())
        else {
            self.clear(device, queue);
            return;
        };

        let settings = &caption_data.settings;
        let (width, height) = (output_size.x as f32, output_size.y as f32);
        let font_size = (settings.size as f32 * height / REFERENCE_HEIGHT).max(1.0);
        let text_width = (width * MAX_WIDTH_RATIO).max(1.0);

        self.refresh_fonts();
        self.layout(LayoutKey {
            text: caption.text.trim().to_string(),
            font: settings.font.clone(),
            bold: settings.bold,
            italic: settings.italic,
            font_size: (font_size * 10.0).round() as u32,
            width: text_width.round() as u32,
        });

        let (block_width, block_height) = self.block_size();
        let margin = height * EDGE_MARGIN_RATIO;
        let text_top = match settings.position.as_str() {
            "top" => margin,
            "middle" => (height - block_height) / 2.0,
            _ => height - margin - block_height,
        };
        let text_left = (width - text_width) / 2.0;

        let color = rgba(&settings.color, 1.0);
        let outline_color = rgba(&settings.outline_color, 1.0);
        let background_color = rgba(
            &settings.background_color,
            settings.background_opacity.min(100) as f32 / 100.0,
        );

        let background_glyph = (settings.background
            && settings.background_opacity > 0
            && block_width > 0.0)
            .then(|| {
                let padding_x = font_size * BOX_PADDING_X_EM;
                let padding_y = font_size * BOX_PADDING_Y_EM;
                CustomGlyph {
                    id: 0,
                    left: text_left + (text_width - block_width) / 2.0 - padding_x,
                    top: text_top - padding_y,
                    width: block_width + padding_x * 2.0,
                    height: block_height + padding_y * 2.0,
                    color: Some(background_color),
                    snap_to_physical_pixel: true,
                    metadata: 0,
                }
            });
        let background_glyphs: Vec<CustomGlyph> = background_glyph.into_iter().collect();

        let bounds = TextBounds {
            left: 0,
            top: 0,
            right: output_size.x as i32,
            bottom: output_size.y as i32,
        };

        let mut text_areas = Vec::new();

        if !background_glyphs.is_empty() {
            text_areas.push(TextArea {
                buffer: &self.empty_buffer,
                left: 0.0,
                top: 0.0,
                scale: 1.0,
                bounds,
                default_color: background_color,
                custom_glyphs: &background_glyphs,
            });
        }

        if settings.outline {
            for (dx, dy) in outline_offsets((font_size * OUTLINE_EM).max(1.0)) {
                text_areas.push(TextArea {
                    buffer: &self.text_buffer,
                    left: text_left + dx,
                    top: text_top + dy,
                    scale: 1.0,
                    bounds,
                    default_color: outline_color,
                    custom_glyphs: &[],
                });
            }
        }

        text_areas.push(TextArea {
            buffer: &self.text_buffer,
            left: text_left,
            top: text_top,
            scale: 1.0,
            bounds,
            default_color: color,
            custom_glyphs: &[],
        });

        self.viewport.update(
            queue,
            Resolution {
                width: output_size.x,
                height: output_size.y,
            },
        );

        if let Err(e) = self.text_renderer.prepare_with_custom(
            device,
            queue,
            &mut self.font_system,
            &mut self.text_atlas,
            &self.viewport,
            text_areas,
            &mut self.swash_cache,
            |request| {
                Some(RasterizedCustomGlyph {
                    data: rounded_rect_mask(request.width, request.height),
                    content_type: ContentType::Mask,
                })
            },
        ) {
            warn!("Error preparing captions: {e:?}");
        }
    }

    pub fn render<'a>(&'a self, pass: &mut wgpu::RenderPass<'a>) {
        if let Err(e) = self
            .text_renderer
            .render(&self.text_atlas, &self.viewport, pass)
        {
            warn!("Error rendering captions: {e:?}");
        }
    }
}

fn rgba(hex: &str, alpha: f32) -> Color {
    let channel = |index| (parse_color_component(hex, index) * 255.0).round() as u8;
    Color::rgba(
        channel(0),
        channel(1),
        channel(2),
        (alpha.clamp(0.0, 1.0) * 255.0).round() as u8,
    )
}

fn outline_offsets(width: f32) -> Vec<(f32, f32)> {
    let steps = if width <= 1.5 {
        8
    } else if width <= 3.0 {
        12
    } else {
        16
    };
    let rings: &[f32] = if width > 2.5 { &[1.0, 0.5] } else { &[1.0] };

    rings
        .iter()
        .flat_map(|ring| {
            (0..steps).map(move |step| {
                let angle = step as f32 / steps as f32 * TAU;
                (angle.cos() * width * ring, angle.sin() * width * ring)
            })
        })
        .collect()
}

fn rounded_rect_mask(width: u16, height: u16) -> Vec<u8> {
    let (w, h) = (width as f32, height as f32);
    let radius = (h * BOX_RADIUS_RATIO).min(w / 2.0).min(h / 2.0);
    let mut data = vec![0u8; width as usize * height as usize];

    for y in 0..height as usize {
        for x in 0..width as usize {
            let px = x as f32 + 0.5;
            let py = y as f32 + 0.5;
            let cx = px.clamp(radius, w - radius);
            let cy = py.clamp(radius, h - radius);
            let distance = (px - cx).hypot(py - cy);
            let coverage = (radius - distance + 0.5).clamp(0.0, 1.0);
            data[y * width as usize + x] = (coverage * 255.0).round() as u8;
        }
    }

    data
}

pub fn find_caption_at_time_project(
    time: f32,
    segments: &[cap_project::CaptionSegment],
) -> Option<&cap_project::CaptionSegment> {
    segments
        .iter()
        .find(|segment| time >= segment.start && time < segment.end)
}

#[cfg(test)]
mod tests {
    use super::{outline_offsets, rounded_rect_mask};

    #[test]
    fn outline_rings_scale_with_width() {
        assert_eq!(outline_offsets(1.0).len(), 8);
        assert_eq!(outline_offsets(4.0).len(), 32);
        let furthest = outline_offsets(4.0)
            .iter()
            .map(|(x, y)| x.hypot(*y))
            .fold(0.0_f32, f32::max);
        assert!((furthest - 4.0).abs() < 1e-3);
    }

    #[test]
    fn rounded_rect_is_solid_inside_and_clear_in_corners() {
        let mask = rounded_rect_mask(100, 40);
        assert_eq!(mask.len(), 4000);
        assert_eq!(mask[20 * 100 + 50], 255);
        assert_eq!(mask[0], 0);
        assert_eq!(mask[20 * 100], 255);
    }
}
