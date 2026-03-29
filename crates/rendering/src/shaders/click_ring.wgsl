struct Uniforms {
    position: vec2<f32>,
    output_size: vec2<f32>,
    color: vec4<f32>,
    ring_size: f32,
    progress: f32,
    opacity: f32,
    _padding: f32,
}

@group(0) @binding(0)
var<uniform> uniforms: Uniforms;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOutput {
    var positions = array<vec2<f32>, 4>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(1.0, -1.0),
        vec2<f32>(-1.0, 1.0),
        vec2<f32>(1.0, 1.0)
    );

    let pos = positions[vertex_index];

    var output: VertexOutput;
    output.position = vec4<f32>(pos, 0.0, 1.0);
    output.uv = (pos + 1.0) * 0.5;
    output.uv.y = 1.0 - output.uv.y;

    return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
    let pixel_pos = input.uv * uniforms.output_size;
    let center = uniforms.position;

    let dist = distance(pixel_pos, center);

    let max_radius = uniforms.ring_size * (0.5 + uniforms.progress * 1.5);
    let ring_width = uniforms.ring_size * 0.15 * (1.0 - uniforms.progress * 0.5);

    let inner_radius = max_radius - ring_width;
    let outer_radius = max_radius;

    let ring_alpha = smoothstep(inner_radius - 2.0, inner_radius, dist) *
                     smoothstep(outer_radius + 2.0, outer_radius, dist);

    let fade = 1.0 - uniforms.progress;
    let final_alpha = ring_alpha * fade * uniforms.opacity * uniforms.color.a;

    if (final_alpha < 0.001) {
        discard;
    }

    let premultiplied_color = uniforms.color.rgb * final_alpha;

    return vec4<f32>(premultiplied_color, final_alpha);
}
