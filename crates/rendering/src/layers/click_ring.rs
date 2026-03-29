use bytemuck::{Pod, Zeroable};
use cap_project::{CursorEvents, XY};
use wgpu::{include_wgsl, util::DeviceExt};

use crate::{
    Coord, DecodedSegmentFrames, FrameSpace, ProjectUniforms, RenderVideoConstants,
    zoom::InterpolatedZoom,
};

pub struct ClickRingLayer {
    statics: Statics,
    active_clicks: Vec<ActiveClick>,
    current_time_ms: f64,
}

struct ActiveClick {
    position: Coord<FrameSpace>,
    start_time_ms: f64,
    duration_ms: f64,
}

struct Statics {
    uniform_buffer: wgpu::Buffer,
    #[allow(dead_code)]
    bind_group_layout: wgpu::BindGroupLayout,
    bind_group: wgpu::BindGroup,
    render_pipeline: wgpu::RenderPipeline,
}

impl Statics {
    fn new(device: &wgpu::Device) -> Self {
        let bind_group_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("Click Ring Pipeline Layout"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });

        let shader = device.create_shader_module(include_wgsl!("../shaders/click_ring.wgsl"));

        let render_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("Click Ring Pipeline"),
            layout: Some(
                &device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                    label: Some("Click Ring Pipeline Layout"),
                    bind_group_layouts: &[&bind_group_layout],
                    push_constant_ranges: &[],
                }),
            ),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[],
                    zero_initialize_workgroup_memory: false,
                },
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba8UnormSrgb,
                    blend: Some(wgpu::BlendState {
                        color: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                        alpha: wgpu::BlendComponent {
                            src_factor: wgpu::BlendFactor::One,
                            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
                            operation: wgpu::BlendOperation::Add,
                        },
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: wgpu::PipelineCompilationOptions {
                    constants: &[],
                    zero_initialize_workgroup_memory: false,
                },
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                strip_index_format: None,
                front_face: wgpu::FrontFace::Ccw,
                cull_mode: None,
                unclipped_depth: false,
                polygon_mode: wgpu::PolygonMode::Fill,
                conservative: false,
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        let uniform_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Click Ring Uniform Buffer"),
            contents: bytemuck::cast_slice(&[ClickRingUniforms::default()]),
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
        });

        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            layout: &bind_group_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform_buffer.as_entire_binding(),
            }],
            label: Some("Click Ring Bind Group"),
        });

        Self {
            bind_group_layout,
            render_pipeline,
            uniform_buffer,
            bind_group,
        }
    }
}

impl ClickRingLayer {
    pub fn new(device: &wgpu::Device) -> Self {
        Self {
            statics: Statics::new(device),
            active_clicks: Vec::new(),
            current_time_ms: 0.0,
        }
    }

    pub fn prepare(
        &mut self,
        segment_frames: &DecodedSegmentFrames,
        resolution_base: XY<u32>,
        cursor: &CursorEvents,
        zoom: &InterpolatedZoom,
        uniforms: &ProjectUniforms,
        constants: &RenderVideoConstants,
    ) {
        let click_effect = &uniforms.project.cursor.click_effect;

        if !click_effect.enabled || uniforms.project.cursor.hide {
            self.active_clicks.clear();
            return;
        }

        let current_time_ms = segment_frames.recording_time as f64 * 1000.0;
        let duration_ms = click_effect.duration as f64 * 1000.0;

        self.current_time_ms = current_time_ms;
        self.active_clicks.clear();

        for click in &cursor.clicks {
            if click.down {
                let click_age = current_time_ms - click.time_ms;

                if click_age >= 0.0 && click_age <= duration_ms {
                    if let Some(cursor_pos) = find_cursor_position_at_time(cursor, click.time_ms) {
                        let position = Coord::<crate::RawDisplayUVSpace>::new(cursor_pos)
                            .to_frame_space(
                                &constants.options,
                                &uniforms.project,
                                resolution_base,
                            );

                        let zoomed_position = position.to_zoomed_frame_space(
                            &constants.options,
                            &uniforms.project,
                            resolution_base,
                            zoom,
                        );

                        self.active_clicks.push(ActiveClick {
                            position: Coord::new(XY::new(
                                zoomed_position.x,
                                zoomed_position.y,
                            )),
                            start_time_ms: click.time_ms,
                            duration_ms,
                        });
                    }
                }
            }
        }
    }

    pub fn render(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        queue: &wgpu::Queue,
        uniforms: &ProjectUniforms,
    ) {
        let click_effect = &uniforms.project.cursor.click_effect;

        if !click_effect.enabled || self.active_clicks.is_empty() {
            return;
        }

        let color = parse_hex_color(&click_effect.color);

        pass.set_pipeline(&self.statics.render_pipeline);
        pass.set_bind_group(0, &self.statics.bind_group, &[]);

        for click in &self.active_clicks {
            let elapsed = self.current_time_ms - click.start_time_ms;
            let progress = (elapsed / click.duration_ms).clamp(0.0, 1.0) as f32;

            let click_uniforms = ClickRingUniforms {
                position: [click.position.x as f32, click.position.y as f32],
                output_size: [
                    uniforms.output_size.0 as f32,
                    uniforms.output_size.1 as f32,
                ],
                color: [color[0], color[1], color[2], color[3]],
                ring_size: click_effect.size,
                progress,
                opacity: click_effect.opacity,
                _padding: 0.0,
            };

            queue.write_buffer(
                &self.statics.uniform_buffer,
                0,
                bytemuck::cast_slice(&[click_uniforms]),
            );

            pass.draw(0..4, 0..1);
        }
    }

    pub fn has_active_clicks(&self) -> bool {
        !self.active_clicks.is_empty()
    }
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Pod, Zeroable, Default)]
struct ClickRingUniforms {
    position: [f32; 2],
    output_size: [f32; 2],
    color: [f32; 4],
    ring_size: f32,
    progress: f32,
    opacity: f32,
    _padding: f32,
}

fn find_cursor_position_at_time(cursor: &CursorEvents, time_ms: f64) -> Option<XY<f64>> {
    if cursor.moves.is_empty() {
        return None;
    }

    let mut closest_move = &cursor.moves[0];
    let mut closest_diff = f64::MAX;

    for m in &cursor.moves {
        let diff = (m.time_ms - time_ms).abs();
        if diff < closest_diff {
            closest_diff = diff;
            closest_move = m;
        }
        if m.time_ms > time_ms {
            break;
        }
    }

    Some(XY::new(closest_move.x, closest_move.y))
}

fn parse_hex_color(hex: &str) -> [f32; 4] {
    let hex = hex.trim_start_matches('#');

    if hex.len() >= 6 {
        let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(255) as f32 / 255.0;
        let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(204) as f32 / 255.0;
        let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0) as f32 / 255.0;
        let a = if hex.len() >= 8 {
            u8::from_str_radix(&hex[6..8], 16).unwrap_or(255) as f32 / 255.0
        } else {
            1.0
        };
        [r, g, b, a]
    } else {
        [1.0, 0.8, 0.0, 1.0]
    }
}
