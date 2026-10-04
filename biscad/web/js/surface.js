const surface_canvas = document.querySelector("canvas.surface");
const prefers_reduced_motion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const texture_layer_names = ["brushed_metal", "powder_grain", "worn_concrete"];
const texture_map_names = ["normal", "surface"];
const maximum_device_pixel_ratio = 1.5;
const light_height_above_surface_in_css_pixels = 300;
const light_follow_fraction_per_frame = 0.07;
const idle_time_before_light_drifts_in_milliseconds = 5000;
const parallax_fraction_of_scroll = 0.35;

const vertex_shader_source = `#version 300 es
in vec2 clip_position;
void main() { gl_Position = vec4(clip_position, 0.0, 1.0); }`;

const fragment_shader_source = `#version 300 es
precision highp float;
uniform sampler2D brushed_metal_normal, brushed_metal_surface, powder_grain_normal, powder_grain_surface, worn_concrete_normal, worn_concrete_surface;
uniform vec2 viewport_size_in_css_pixels;
uniform vec3 light_position_in_css_pixels;
uniform float scroll_offset_in_css_pixels;
uniform float device_pixel_ratio;
out vec4 fragment_color;

struct hex_tile_blend { vec2 offset_a; vec2 offset_b; vec2 offset_c; vec3 weights; };

vec2 random_offset_for_cell(vec2 cell) {
  return fract(sin(vec2(dot(cell, vec2(127.1, 311.7)), dot(cell, vec2(269.5, 183.3)))) * 43758.5453);
}

hex_tile_blend find_hex_tile_blend(vec2 texture_coordinate) {
  vec2 skewed_coordinate = mat2(1.0, -0.57735027, 0.0, 1.15470054) * texture_coordinate * 2.6;
  vec2 base_cell = floor(skewed_coordinate);
  vec2 cell_fraction = fract(skewed_coordinate);
  float third_barycentric = 1.0 - cell_fraction.x - cell_fraction.y;
  bool is_lower_triangle = third_barycentric > 0.0;
  vec3 weights = is_lower_triangle ? vec3(third_barycentric, cell_fraction.y, cell_fraction.x) : vec3(-third_barycentric, 1.0 - cell_fraction.y, 1.0 - cell_fraction.x);
  vec2 corner_a = is_lower_triangle ? base_cell : base_cell + 1.0;
  vec2 corner_b = base_cell + (is_lower_triangle ? vec2(0.0, 1.0) : vec2(1.0, 0.0));
  vec2 corner_c = base_cell + (is_lower_triangle ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec3 sharpened_weights = pow(weights, vec3(5.0));
  sharpened_weights /= dot(sharpened_weights, vec3(1.0));
  return hex_tile_blend(random_offset_for_cell(corner_a), random_offset_for_cell(corner_b), random_offset_for_cell(corner_c), sharpened_weights);
}

vec4 sample_without_visible_repetition(sampler2D layer_texture, vec2 texture_coordinate, hex_tile_blend blend) {
  vec2 coordinate_change_along_x = dFdx(texture_coordinate);
  vec2 coordinate_change_along_y = dFdy(texture_coordinate);
  return textureGrad(layer_texture, texture_coordinate + blend.offset_a, coordinate_change_along_x, coordinate_change_along_y) * blend.weights.x
       + textureGrad(layer_texture, texture_coordinate + blend.offset_b, coordinate_change_along_x, coordinate_change_along_y) * blend.weights.y
       + textureGrad(layer_texture, texture_coordinate + blend.offset_c, coordinate_change_along_x, coordinate_change_along_y) * blend.weights.z;
}

vec2 slope_from_normal_sample(vec4 normal_sample) { return normal_sample.xy * 2.0 - 1.0; }

void main() {
  vec2 point_on_screen = vec2(gl_FragCoord.x, viewport_size_in_css_pixels.y * device_pixel_ratio - gl_FragCoord.y) / device_pixel_ratio;
  vec2 point_on_surface = point_on_screen + vec2(0.0, scroll_offset_in_css_pixels);
  vec2 brushed_coordinate = point_on_surface / vec2(1100.0, 1100.0);
  vec2 grain_coordinate = point_on_surface / 300.0;
  vec2 wear_coordinate = point_on_surface / 1500.0 + 0.37;
  hex_tile_blend brushed_blend = find_hex_tile_blend(brushed_coordinate);
  hex_tile_blend grain_blend = find_hex_tile_blend(grain_coordinate);
  hex_tile_blend wear_blend = find_hex_tile_blend(wear_coordinate);
  vec4 brushed_surface = sample_without_visible_repetition(brushed_metal_surface, brushed_coordinate, brushed_blend);
  vec4 grain_surface = sample_without_visible_repetition(powder_grain_surface, grain_coordinate, grain_blend);
  vec4 wear_surface = sample_without_visible_repetition(worn_concrete_surface, wear_coordinate, wear_blend);
  vec2 combined_slope = slope_from_normal_sample(sample_without_visible_repetition(brushed_metal_normal, brushed_coordinate, brushed_blend)) * 3.0
                      + slope_from_normal_sample(sample_without_visible_repetition(powder_grain_normal, grain_coordinate, grain_blend)) * 1.4
                      + slope_from_normal_sample(sample_without_visible_repetition(worn_concrete_normal, wear_coordinate, wear_blend)) * 1.2;
  vec3 surface_normal = normalize(vec3(combined_slope.x, -combined_slope.y, 1.0));

  float roughness = clamp(0.30 + 0.30 * brushed_surface.r + 0.35 * (wear_surface.r - 0.5) + 0.20 * (grain_surface.r - 0.5), 0.14, 0.92);
  float occlusion = mix(1.0, grain_surface.g, 0.35) * mix(1.0, wear_surface.g, 0.45);
  vec3 albedo = mix(vec3(0.010, 0.0016, 0.0022), vec3(0.034, 0.0045, 0.0065), brushed_surface.g);

  vec3 offset_to_light = light_position_in_css_pixels - vec3(point_on_screen, 0.0);
  float distance_to_light = length(offset_to_light);
  vec3 light_direction = offset_to_light / distance_to_light;
  vec2 viewport_center = viewport_size_in_css_pixels * 0.5;
  vec3 view_direction = normalize(vec3(viewport_center - point_on_screen, 1.6 * max(viewport_size_in_css_pixels.x, viewport_size_in_css_pixels.y)));
  vec3 half_direction = normalize(light_direction + view_direction);
  float normal_dot_light = max(dot(surface_normal, light_direction), 0.0);
  float normal_dot_view = max(dot(surface_normal, view_direction), 0.001);
  float normal_dot_half = max(dot(surface_normal, half_direction), 0.0);
  float alpha_squared = pow(roughness, 4.0);
  float distribution = alpha_squared / (3.14159265 * pow(normal_dot_half * normal_dot_half * (alpha_squared - 1.0) + 1.0, 2.0));
  float geometry_k = roughness * roughness * 0.5;
  float geometry = normal_dot_light / (normal_dot_light * (1.0 - geometry_k) + geometry_k) * normal_dot_view / (normal_dot_view * (1.0 - geometry_k) + geometry_k);
  vec3 reflectance_at_normal = vec3(0.42, 0.045, 0.06);
  vec3 fresnel = reflectance_at_normal + (1.0 - reflectance_at_normal) * pow(1.0 - max(dot(half_direction, view_direction), 0.0), 5.0);
  vec3 specular = distribution * geometry * fresnel / (4.0 * normal_dot_light * normal_dot_view + 0.0001);
  float light_reach_in_css_pixels = 0.42 * max(viewport_size_in_css_pixels.x, viewport_size_in_css_pixels.y);
  float light_falloff = 1.0 / (1.0 + pow(distance_to_light / light_reach_in_css_pixels, 2.0));
  vec3 light_radiance = vec3(1.0, 0.82, 0.76) * 1.7 * light_falloff;
  vec3 direct_light = (albedo + specular * 0.6) * normal_dot_light * light_radiance;
  float height_on_screen = point_on_screen.y / viewport_size_in_css_pixels.y;
  vec3 ambient_light = albedo * (0.55 - 0.3 * height_on_screen) + vec3(0.010, 0.0016, 0.002) * occlusion;
  vec3 linear_color = (direct_light + ambient_light) * occlusion;
  vec2 centered_screen = (point_on_screen / viewport_size_in_css_pixels - 0.5) * vec2(viewport_size_in_css_pixels.x / viewport_size_in_css_pixels.y, 1.0);
  linear_color *= smoothstep(1.35, 0.15, length(centered_screen));
  vec3 tone_mapped_color = linear_color / (1.0 + linear_color);
  float dither = (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  fragment_color = vec4(pow(tone_mapped_color, vec3(1.0 / 2.2)) + dither, 1.0);
}`;

function compile_shader(gl, shader_type, shader_source) {
  const shader = gl.createShader(shader_type);
  gl.shaderSource(shader, shader_source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  throw new Error(`surface shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
}

function link_surface_program(gl) {
  const program = gl.createProgram();
  gl.attachShader(program, compile_shader(gl, gl.VERTEX_SHADER, vertex_shader_source));
  gl.attachShader(program, compile_shader(gl, gl.FRAGMENT_SHADER, fragment_shader_source));
  gl.linkProgram(program);
  if (gl.getProgramParameter(program, gl.LINK_STATUS)) return program;
  throw new Error(`surface program failed to link: ${gl.getProgramInfoLog(program)}`);
}

function bind_fullscreen_triangle(gl, program) {
  const vertex_buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vertex_buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position_location = gl.getAttribLocation(program, "clip_position");
  gl.enableVertexAttribArray(position_location);
  gl.vertexAttribPointer(position_location, 2, gl.FLOAT, false, 0, 0);
}

function load_image(image_url) {
  const image = new Image();
  image.src = image_url;
  return image.decode().then(() => image);
}

function upload_repeating_texture(gl, image, texture_unit_index, anisotropy_extension) {
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + texture_unit_index);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  if (anisotropy_extension) gl.texParameterf(gl.TEXTURE_2D, anisotropy_extension.TEXTURE_MAX_ANISOTROPY_EXT, 8);
}

function list_texture_uniforms() {
  return texture_layer_names.flatMap(layer_name => texture_map_names.map(map_name => ({
    uniform_name: `${layer_name}_${map_name}`,
    image_url: `textures/${layer_name}/${map_name}.jpg`,
  })));
}

async function upload_all_textures(gl, program) {
  const texture_uniforms = list_texture_uniforms();
  const images = await Promise.all(texture_uniforms.map(texture_uniform => load_image(texture_uniform.image_url)));
  const anisotropy_extension = gl.getExtension("EXT_texture_filter_anisotropic");
  gl.useProgram(program);
  images.forEach((image, texture_unit_index) => {
    upload_repeating_texture(gl, image, texture_unit_index, anisotropy_extension);
    gl.uniform1i(gl.getUniformLocation(program, texture_uniforms[texture_unit_index].uniform_name), texture_unit_index);
  });
}

function compute_idle_light_position(time_in_milliseconds, viewport_width, viewport_height) {
  const phase_in_radians = time_in_milliseconds / 9000;
  return {
    target_x: viewport_width * (0.62 + 0.22 * Math.sin(phase_in_radians)),
    target_y: viewport_height * (0.32 + 0.16 * Math.sin(phase_in_radians * 1.37 + 1.1)),
  };
}

function create_surface_renderer(gl, program) {
  const uniform_locations = Object.fromEntries(["viewport_size_in_css_pixels", "light_position_in_css_pixels", "scroll_offset_in_css_pixels", "device_pixel_ratio"]
    .map(uniform_name => [uniform_name, gl.getUniformLocation(program, uniform_name)]));
  const light_state = { target_x: innerWidth * 0.66, target_y: innerHeight * 0.3, current_x: innerWidth * 0.66, current_y: innerHeight * 0.3, last_pointer_time: -Infinity };
  let animation_frame_request = 0;

  function resize_canvas_to_viewport() {
    const device_pixel_ratio = Math.min(devicePixelRatio || 1, maximum_device_pixel_ratio);
    surface_canvas.width = Math.round(innerWidth * device_pixel_ratio);
    surface_canvas.height = Math.round(innerHeight * device_pixel_ratio);
    gl.viewport(0, 0, surface_canvas.width, surface_canvas.height);
    gl.uniform2f(uniform_locations.viewport_size_in_css_pixels, innerWidth, innerHeight);
    gl.uniform1f(uniform_locations.device_pixel_ratio, device_pixel_ratio);
  }

  function move_light_toward_target(time_in_milliseconds) {
    const is_idle = time_in_milliseconds - light_state.last_pointer_time > idle_time_before_light_drifts_in_milliseconds;
    if (is_idle && !prefers_reduced_motion) Object.assign(light_state, compute_idle_light_position(time_in_milliseconds, innerWidth, innerHeight));
    const follow_fraction = prefers_reduced_motion ? 1 : light_follow_fraction_per_frame;
    light_state.current_x += (light_state.target_x - light_state.current_x) * follow_fraction;
    light_state.current_y += (light_state.target_y - light_state.current_y) * follow_fraction;
  }

  function draw_frame(time_in_milliseconds) {
    animation_frame_request = 0;
    move_light_toward_target(time_in_milliseconds);
    gl.uniform3f(uniform_locations.light_position_in_css_pixels, light_state.current_x, light_state.current_y, light_height_above_surface_in_css_pixels);
    gl.uniform1f(uniform_locations.scroll_offset_in_css_pixels, scrollY * parallax_fraction_of_scroll);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    document.documentElement.classList.add("surface_ready");
    if (!prefers_reduced_motion) request_frame();
  }

  function request_frame() {
    if (document.hidden || animation_frame_request) return;
    animation_frame_request = requestAnimationFrame(draw_frame);
  }

  function follow_pointer(pointer_event) {
    light_state.target_x = pointer_event.clientX;
    light_state.target_y = pointer_event.clientY;
    light_state.last_pointer_time = performance.now();
    request_frame();
  }

  function pause_or_resume_with_tab_visibility() {
    if (!document.hidden) return request_frame();
    cancelAnimationFrame(animation_frame_request);
    animation_frame_request = 0;
  }

  addEventListener("resize", () => { resize_canvas_to_viewport(); request_frame(); });
  addEventListener("scroll", request_frame, { passive: true });
  addEventListener("pointermove", follow_pointer, { passive: true });
  addEventListener("pointerdown", follow_pointer, { passive: true });
  document.addEventListener("visibilitychange", pause_or_resume_with_tab_visibility);
  resize_canvas_to_viewport();
  request_frame();
}

async function start_surface() {
  const gl = surface_canvas && surface_canvas.getContext("webgl2", { antialias: false, alpha: false, powerPreference: "low-power" });
  if (!gl) return;
  const program = link_surface_program(gl);
  bind_fullscreen_triangle(gl, program);
  await upload_all_textures(gl, program);
  create_surface_renderer(gl, program);
}

start_surface().catch(surface_error => {
  document.documentElement.dataset.surface = "fallback";
  console.warn(surface_error);
});
