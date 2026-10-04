import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const selection_color = 0xb3101f;
const ember_color = 0xff4a3d;
const agent_highlight_color = 0x4a8dff;
const dimension_color = 0xc9a36a;
const default_part_color = '#c9c6c2';
const cube_edge_region_rest_color = 0x241c1d;
const cube_edge_region_hover_color = 0x8a0b1a;
const cube_face_rest_color = new THREE.Color(0xffffff);
const cube_face_hover_color = new THREE.Color(0xc1162b).multiplyScalar(5);
const cube_corner_bevel = 0.3;
const cube_region_span_by_step = { '-1': [-1, -1 + cube_corner_bevel], 0: [-1 + cube_corner_bevel, 1 - cube_corner_bevel], 1: [1 - cube_corner_bevel, 1] };
const cube_region_steps = [-1, 0, 1].flatMap((right_step) => [-1, 0, 1].map((up_step) => [right_step, up_step]));
const camera_flight_duration_in_milliseconds = 520;
const explode_animation_duration_in_milliseconds = 600;
const toast_duration_in_milliseconds = 1600;
const copy_feedback_duration_in_milliseconds = 1400;
const step_replay_interval_in_milliseconds = 1100;
const click_movement_tolerance_in_pixels = 5;
const longest_click_in_milliseconds = 500;
const auto_rotate_speed = 0.55;

const view_directions = {
  iso: [1, -1, 0.82],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, -1e-4, 1],
  bottom: [0, 1e-4, -1],
};
const view_names_in_shortcut_order = Object.keys(view_directions);
const axis_normals = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const render_modes_with_labels = [
  ['shaded-edges', 'Shaded + edges'],
  ['shaded', 'Shaded'],
  ['hidden', 'Hidden line'],
  ['wireframe', 'Wireframe'],
  ['xray', 'X-ray'],
];

function decode_base64_to_array_buffer(base64_text) {
  if (!base64_text) return new ArrayBuffer(0);
  const binary_text = atob(base64_text);
  const decoded_bytes = new Uint8Array(binary_text.length);
  for (let byte_index = 0; byte_index < binary_text.length; byte_index++) decoded_bytes[byte_index] = binary_text.charCodeAt(byte_index);
  return decoded_bytes.buffer;
}
const decode_float32_array = (base64_text) => new Float32Array(decode_base64_to_array_buffer(base64_text));
const decode_uint32_array = (base64_text) => new Uint32Array(decode_base64_to_array_buffer(base64_text));
const vector_from_array = (coordinates) => new THREE.Vector3().fromArray(coordinates);
const ease_in_out_cubic = (progress_fraction) => (progress_fraction < 0.5 ? 4 * progress_fraction * progress_fraction * progress_fraction : 1 - Math.pow(-2 * progress_fraction + 2, 3) / 2);
const describe_box = (box) => ({ min: box.min.toArray(), max: box.max.toArray(), size: box.getSize(new THREE.Vector3()).toArray() });
const box_corners = (box) => [0, 1, 2, 3, 4, 5, 6, 7].map((corner_index) => new THREE.Vector3(corner_index & 4 ? box.max.x : box.min.x, corner_index & 2 ? box.max.y : box.min.y, corner_index & 1 ? box.max.z : box.min.z));
const parse_entity_ids = (entity_ids) => (typeof entity_ids === 'string' ? entity_ids.split(/[\s,]+/).filter(Boolean) : entity_ids || []);

export function format_number(number, decimal_places = 2) {
  if (number == null || !isFinite(number)) return '—';
  const number_without_tiny_noise = Math.abs(number) < 0.5 * 10 ** -decimal_places ? 0 : number;
  const magnitude = Math.abs(number_without_tiny_noise);
  if (magnitude !== 0 && (magnitude >= 1e6 || magnitude < 1e-3)) return number_without_tiny_noise.toExponential(2);
  return (Math.round(number_without_tiny_noise * 10 ** decimal_places) / 10 ** decimal_places).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimal_places });
}
export const format_vector = (vector, decimal_places = 2) => (vector ? [0, 1, 2].map((axis_index) => format_number(vector[axis_index], decimal_places)).join(', ') : '—');

function interpolate_direction_on_sphere(start_direction, end_direction, progress_fraction, output_direction) {
  const angle_between_in_radians = Math.acos(THREE.MathUtils.clamp(start_direction.dot(end_direction), -1, 1));
  if (angle_between_in_radians < 1e-4) return output_direction.copy(start_direction).lerp(end_direction, progress_fraction).normalize();
  if (Math.PI - angle_between_in_radians < 1e-3) {
    const helper_axis = Math.abs(start_direction.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const perpendicular_midpoint = helper_axis.sub(start_direction.clone().multiplyScalar(helper_axis.dot(start_direction))).normalize();
    if (progress_fraction < 0.5) return interpolate_direction_on_sphere(start_direction, perpendicular_midpoint, progress_fraction * 2, output_direction);
    return interpolate_direction_on_sphere(perpendicular_midpoint, end_direction, progress_fraction * 2 - 1, output_direction);
  }
  const sine_of_angle = Math.sin(angle_between_in_radians);
  return output_direction.copy(start_direction).multiplyScalar(Math.sin((1 - progress_fraction) * angle_between_in_radians) / sine_of_angle).addScaledVector(end_direction, Math.sin(progress_fraction * angle_between_in_radians) / sine_of_angle).normalize();
}

function avoid_exactly_vertical_direction(direction) {
  if (Math.abs(direction.z) <= 0.9999) return direction;
  return direction.set(0, direction.z > 0 ? -1e-4 : 1e-4, Math.sign(direction.z)).normalize();
}

function create_element(tag_name, class_name, inner_html) {
  const element = document.createElement(tag_name);
  if (class_name) element.className = class_name;
  if (inner_html != null) element.innerHTML = inner_html;
  return element;
}

function create_square_canvas(size_in_pixels) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size_in_pixels;
  return canvas;
}

function create_srgb_canvas_texture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function draw_radial_gradient_canvas(size_in_pixels, gradient_circles_as_fractions_of_size, color_stops) {
  const canvas = create_square_canvas(size_in_pixels);
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(...gradient_circles_as_fractions_of_size.map((fraction) => fraction * size_in_pixels));
  color_stops.forEach(([stop_offset, stop_color]) => gradient.addColorStop(stop_offset, stop_color));
  context.fillStyle = gradient;
  context.fillRect(0, 0, size_in_pixels, size_in_pixels);
  return canvas;
}

function add_dither_noise_against_banding(canvas) {
  const context = canvas.getContext('2d');
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let byte_index = 0; byte_index < image.data.length; byte_index += 4) {
    const noise_offset = (Math.random() - 0.5) * 3;
    image.data[byte_index] += noise_offset;
    image.data[byte_index + 1] += noise_offset;
    image.data[byte_index + 2] += noise_offset;
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

const draw_viewport_background_texture = () => create_srgb_canvas_texture(add_dither_noise_against_banding(draw_radial_gradient_canvas(512, [0.5, 0.42, 0, 0.5, 0.5, 0.75], [[0, '#363031'], [0.55, '#221d1e'], [1, '#0f0a0b']])));
const draw_floor_glow_texture = () => create_srgb_canvas_texture(draw_radial_gradient_canvas(256, [0.5, 0.5, 0, 0.5, 0.5, 0.5], [[0, 'rgba(255, 226, 218, 0.55)'], [0.45, 'rgba(255, 190, 180, 0.18)'], [1, 'rgba(255, 190, 180, 0)']]));

function draw_cube_face_label(canvas, face_label) {
  const context = canvas.getContext('2d');
  context.fillStyle = '#2e2526';
  context.fillRect(0, 0, 256, 256);
  context.fillStyle = '#e6dcd7';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `600 ${face_label.length > 5 ? 40 : 46}px "IBM Plex Sans", system-ui, sans-serif`;
  if ('letterSpacing' in context) context.letterSpacing = '4px';
  context.fillText(face_label, 128, 132);
}

function create_cube_face_label_texture(face_label) {
  const canvas = create_square_canvas(256);
  draw_cube_face_label(canvas, face_label);
  const texture = create_srgb_canvas_texture(canvas);
  texture.anisotropy = 4;
  return texture;
}

function create_axis_letter_texture(axis_letter, axis_color) {
  const canvas = create_square_canvas(64);
  const context = canvas.getContext('2d');
  context.fillStyle = '#' + axis_color.toString(16).padStart(6, '0');
  context.font = '600 40px "IBM Plex Sans", system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(axis_letter, 32, 34);
  return create_srgb_canvas_texture(canvas);
}

function edge_polyline_points(edge) {
  const sampled_points = edge.points ? decode_float32_array(edge.points) : null;
  if ((!sampled_points || sampled_points.length < 6) && edge.start && edge.end) return new Float32Array([...edge.start, ...edge.end]);
  return sampled_points;
}

function flatten_polyline_into_segments(polyline_points) {
  const segment_coordinates = [];
  for (let coordinate_index = 0; polyline_points && coordinate_index + 5 < polyline_points.length; coordinate_index += 3) segment_coordinates.push(...polyline_points.subarray(coordinate_index, coordinate_index + 6));
  return segment_coordinates;
}

function compute_signed_mesh_volume(positions, triangle_indices) {
  const first_corner = new THREE.Vector3(), second_corner = new THREE.Vector3(), third_corner = new THREE.Vector3();
  let signed_volume = 0;
  for (let index_position = 0; index_position < triangle_indices.length; index_position += 3) {
    first_corner.fromArray(positions, triangle_indices[index_position] * 3);
    second_corner.fromArray(positions, triangle_indices[index_position + 1] * 3);
    third_corner.fromArray(positions, triangle_indices[index_position + 2] * 3);
    signed_volume += first_corner.dot(second_corner.cross(third_corner)) / 6;
  }
  return signed_volume;
}

function find_nearest_triangle_hit(ray, geometry, first_triangle_index, triangle_count) {
  const positions = geometry.attributes.position.array, triangle_indices = geometry.index.array;
  const first_corner = new THREE.Vector3(), second_corner = new THREE.Vector3(), third_corner = new THREE.Vector3(), hit_point = new THREE.Vector3();
  let nearest_point = null, nearest_distance = Infinity;
  for (let triangle_index = first_triangle_index; triangle_index < first_triangle_index + triangle_count; triangle_index++) {
    first_corner.fromArray(positions, triangle_indices[triangle_index * 3] * 3);
    second_corner.fromArray(positions, triangle_indices[triangle_index * 3 + 1] * 3);
    third_corner.fromArray(positions, triangle_indices[triangle_index * 3 + 2] * 3);
    if (!ray.intersectTriangle(first_corner, second_corner, third_corner, false, hit_point)) continue;
    const hit_distance = hit_point.distanceTo(ray.origin);
    if (hit_distance < nearest_distance) [nearest_distance, nearest_point] = [hit_distance, hit_point.clone()];
  }
  return nearest_point;
}

function entity_center_point(entity) {
  if (entity.center) return vector_from_array(entity.center);
  if (entity.kind === 'edge' && entity.start && entity.end) return vector_from_array(entity.start).lerp(vector_from_array(entity.end), 0.5);
  return null;
}

function describe_entity_size(entity) {
  if (entity.kind === 'part') return entity.name;
  if (entity.radius) return `r ${format_number(entity.radius)}`;
  return entity.kind === 'face' ? `${format_number(entity.area)} mm²` : `${format_number(entity.length)} mm`;
}

function describe_part_entity(part) {
  return {
    id: part.id, kind: 'part', part_index: part.index, name: part.name, color: part.color,
    face_count: part.faces.length, edge_count: part.edges.length, triangle_count: part.triangle_count,
    area_in_square_millimeters: part.area_in_square_millimeters, volume_in_cubic_millimeters: part.volume_in_cubic_millimeters, bounding_box: describe_box(part.bounding_box),
  };
}

function apply_render_mode_to_part(part, render_mode, depth_only_material) {
  part.mesh.visible = render_mode !== 'wireframe';
  part.mesh.material = { xray: part.xray_material, hidden: depth_only_material }[render_mode] || part.solid_material;
  if (!part.lines) return;
  part.lines.visible = render_mode !== 'shaded';
  part.line_material.depthTest = render_mode !== 'wireframe';
  part.line_material.opacity = render_mode === 'xray' ? 0.55 : (part.line_material.color.r > 0.1 ? 0.7 : 0.78);
}

function create_section_cap_material(part_color, is_dark_part, clip_planes) {
  const cap_material = new THREE.MeshBasicMaterial({ color: part_color.clone().multiplyScalar(is_dark_part ? 1.6 : 0.78), side: THREE.BackSide, clippingPlanes: clip_planes, toneMapped: false });
  cap_material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        float hatch_phase = fract((gl_FragCoord.x + gl_FragCoord.y) / 10.0);
        float hatch_line_strength = 1.0 - smoothstep(0.08, 0.16, abs(hatch_phase - 0.5));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * 0.72, hatch_line_strength);`);
  };
  return cap_material;
}

function create_shadow_depth_material(shadow_layer, clip_planes) {
  const depth_material = new THREE.MeshDepthMaterial({ side: THREE.DoubleSide });
  Object.assign(depth_material, { clippingPlanes: clip_planes, depthTest: false, depthWrite: false });
  depth_material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
      `gl_FragColor = vec4( vec3( 0.0 ), pow(clamp(1.0 - fragCoordZ, 0.0, 1.0), ${shadow_layer.depth_falloff_exponent.toFixed(2)}) * ${shadow_layer.darkness.toFixed(2)} );`);
  };
  depth_material.customProgramCacheKey = () => 'vc-shadow-' + shadow_layer.depth_falloff_exponent + '-' + shadow_layer.darkness;
  return depth_material;
}

const encode_identifier_glsl = `
vec4 encode_identifier_as_color(float identifier) {
  identifier = floor(identifier + 0.5);
  return vec4(mod(floor(identifier / 65536.0), 256.0), mod(floor(identifier / 256.0), 256.0), mod(identifier, 256.0), 255.0) / 255.0;
}`;
const pick_vertex_shader = `
#include <common>
#include <clipping_planes_pars_vertex>
attribute float pick_identifier;
varying float interpolated_pick_identifier;
void main() {
  interpolated_pick_identifier = pick_identifier;
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
}`;
const pick_fragment_shader = `
#include <clipping_planes_pars_fragment>
varying float interpolated_pick_identifier;
${encode_identifier_glsl}
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = encode_identifier_as_color(interpolated_pick_identifier);
}`;

const grid_vertex_shader = `
varying vec3 world_position;
void main() {
  vec4 world_space_position = modelMatrix * vec4(position, 1.0);
  world_position = world_space_position.xyz;
  gl_Position = projectionMatrix * viewMatrix * world_space_position;
}`;
const grid_fragment_shader = `
uniform float cell_size;
uniform vec3 fade_center;
uniform float fade_distance;
uniform float grid_opacity;
varying vec3 world_position;
float grid_line_strength(vec2 plane_position, float spacing, out float level_of_detail_fade) {
  vec2 cell_coordinate = plane_position / spacing;
  vec2 coordinate_change_per_pixel = fwidth(cell_coordinate);
  vec2 distance_to_line_in_pixels = abs(fract(cell_coordinate - 0.5) - 0.5) / coordinate_change_per_pixel;
  level_of_detail_fade = clamp(max(coordinate_change_per_pixel.x, coordinate_change_per_pixel.y) * 3.0 - 0.5, 0.0, 1.0);
  return 1.0 - min(min(distance_to_line_in_pixels.x, distance_to_line_in_pixels.y), 1.0);
}
void main() {
  float distance_from_center = distance(world_position.xy, fade_center.xy);
  float radial_fade = 1.0 - smoothstep(fade_distance * 0.15, fade_distance, distance_from_center);
  radial_fade *= radial_fade;
  float minor_fade, major_fade;
  float minor_line = grid_line_strength(world_position.xy, cell_size, minor_fade) * (1.0 - minor_fade);
  float major_line = grid_line_strength(world_position.xy, cell_size * 10.0, major_fade) * (1.0 - major_fade * 0.7);
  vec2 axis_width = fwidth(world_position.xy) * 1.2;
  float x_axis_strength = 1.0 - min(abs(world_position.y) / axis_width.y, 1.0);
  float y_axis_strength = 1.0 - min(abs(world_position.x) / axis_width.x, 1.0);
  float line_alpha = max(minor_line * 0.07, major_line * 0.15);
  vec3 line_color = vec3(1.0, 0.88, 0.86);
  if (x_axis_strength > 0.01) { line_color = mix(line_color, vec3(0.86, 0.22, 0.22), x_axis_strength); line_alpha = max(line_alpha, x_axis_strength * 0.55); }
  if (y_axis_strength > 0.01) { line_color = mix(line_color, vec3(0.42, 0.7, 0.36), y_axis_strength); line_alpha = max(line_alpha, y_axis_strength * 0.55); }
  line_alpha *= grid_opacity * radial_fade;
  if (line_alpha <= 0.002) discard;
  gl_FragColor = vec4(line_color, line_alpha);
}`;

const blur_vertex_shader = `
varying vec2 texture_coordinate;
void main() { texture_coordinate = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const blur_fragment_shader = `
uniform sampler2D source_texture;
uniform vec2 blur_direction;
varying vec2 texture_coordinate;
void main() {
  vec4 blurred_color = vec4(0.0);
  blurred_color += texture2D(source_texture, texture_coordinate - 4.0 * blur_direction) * 0.051;
  blurred_color += texture2D(source_texture, texture_coordinate - 3.0 * blur_direction) * 0.0918;
  blurred_color += texture2D(source_texture, texture_coordinate - 2.0 * blur_direction) * 0.12245;
  blurred_color += texture2D(source_texture, texture_coordinate - 1.0 * blur_direction) * 0.1531;
  blurred_color += texture2D(source_texture, texture_coordinate) * 0.1633;
  blurred_color += texture2D(source_texture, texture_coordinate + 1.0 * blur_direction) * 0.1531;
  blurred_color += texture2D(source_texture, texture_coordinate + 2.0 * blur_direction) * 0.12245;
  blurred_color += texture2D(source_texture, texture_coordinate + 3.0 * blur_direction) * 0.0918;
  blurred_color += texture2D(source_texture, texture_coordinate + 4.0 * blur_direction) * 0.051;
  gl_FragColor = blurred_color;
}`;

export class Viewer extends EventTarget {
  constructor(container_element, viewer_options = {}) {
    super();
    this.container_element = container_element;
    this.options = { show_view_cube: true, show_grid: true, enable_keyboard_shortcuts: true, measure_with_kernel: null, is_interactive: true, ...viewer_options };
    container_element.classList.add('vc-viewer');
    if (getComputedStyle(container_element).position === 'static') container_element.style.position = 'relative';
    this.state = {
      render_mode: 'shaded-edges', projection: 'perspective', tool: 'select',
      section: { is_enabled: false, axis: 'x', normal: [1, 0, 0], offset_fraction: 0.5, is_flipped: false },
      explode_fraction: 0, show_bounding_box: false, show_grid: this.options.show_grid, show_shadow: true, ambient_occlusion_enabled: false,
    };
    this.selection = [];
    this.highlighted_ids = [];
    this.hovered_id = null;
    this.measure_picks = [];
    this.measurement = null;
    this.parts = [];
    this.loaded_scene = null;
    this.version_id = null;
    this.needs_render = true;
    this.screen_labels = [];
    this.shortcut_actions = this.create_shortcut_actions();
    this.create_renderer();
    this.create_scene();
    if (this.options.show_view_cube) this.create_view_cube();
    this.create_overlay();
    this.listen_to_pointer();
    if (this.options.enable_keyboard_shortcuts) window.addEventListener('keydown', (key_event) => this.handle_shortcut_key(key_event));
    new ResizeObserver(() => this.resize_to_container()).observe(container_element);
    this.resize_to_container();
    this.animate_frame = this.animate_frame.bind(this);
    requestAnimationFrame(this.animate_frame);
  }

  create_renderer() {
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: !!this.options.is_transparent, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (this.options.is_transparent) renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 0.9;
    renderer.localClippingEnabled = true;
    renderer.domElement.className = 'vc-canvas';
    renderer.domElement.setAttribute('tabindex', '0');
    this.container_element.appendChild(renderer.domElement);
    this.pick_render_target = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
    this.picked_pixel_bytes = new Uint8Array(4);
  }

  create_scene() {
    const scene = this.scene = new THREE.Scene();
    scene.background = this.options.is_transparent ? null : draw_viewport_background_texture();
    const environment_generator = new THREE.PMREMGenerator(this.renderer);
    const room_environment = new RoomEnvironment();
    scene.environment = environment_generator.fromScene(room_environment, 0.035).texture;
    room_environment.dispose?.();
    environment_generator.dispose();
    scene.environmentIntensity = 0.5;
    scene.environmentRotation = new THREE.Euler(Math.PI / 2, 0, 0);
    this.create_camera_relative_lights();
    this.create_cameras_and_controls();
    this.root = new THREE.Group();
    this.helpers = new THREE.Group();
    this.ghost_root = new THREE.Group();
    scene.add(this.root, this.ghost_root, this.helpers);
    this.clip_plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    this.clip_planes = [];
    this.create_shared_materials();
    this.create_grid();
    this.create_contact_shadow();
    this.create_section_helper();
  }

  create_camera_relative_lights() {
    const light_target = new THREE.Object3D();
    light_target.position.set(0, 0, -1);
    const camera_relative_lights = [[0xffffff, 1.25, [-0.6, 0.9, 1]], [0xffffff, 0.22, [0.8, -0.4, 0.6]], [0xffe6e0, 0.9, [0.4, 1.2, -2.2]]].map(([light_color, light_intensity, light_position]) => {
      const directional_light = new THREE.DirectionalLight(light_color, light_intensity);
      directional_light.position.fromArray(light_position);
      directional_light.target = light_target;
      return directional_light;
    });
    this.light_rig = new THREE.Group();
    this.light_rig.add(...camera_relative_lights, light_target);
    this.scene.add(this.light_rig);
  }

  create_cameras_and_controls() {
    this.perspective_camera = new THREE.PerspectiveCamera(32, 1, 0.1, 10000);
    this.orthographic_camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
    this.perspective_camera.position.set(200, -200, 160);
    this.camera = this.perspective_camera;
    const controls = this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    Object.assign(controls, { enableDamping: true, dampingFactor: 0.14, zoomToCursor: true, screenSpacePanning: true, rotateSpeed: 0.85, zoomSpeed: 1.1 });
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    controls.addEventListener('change', () => { this.needs_render = true; });
    controls.addEventListener('start', () => { this.camera_flight = null; this.hide_tooltip(); this.set_auto_rotate(false); });
    if (this.options.auto_rotate) this.set_auto_rotate(true);
  }

  create_shared_materials() {
    const clip_planes = this.clip_planes;
    this.pick_material = new THREE.ShaderMaterial({ vertexShader: pick_vertex_shader, fragmentShader: pick_fragment_shader, clipping: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: clip_planes });
    this.pick_line_material = new LineMaterial({ linewidth: 11, worldUnits: false, clippingPlanes: clip_planes });
    this.pick_line_material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace('void main() {', 'attribute float instance_edge_identifier;\nvarying float interpolated_pick_identifier;\nvoid main() {\n\tinterpolated_pick_identifier = instance_edge_identifier;');
      const fragment_shader_with_declarations = shader.fragmentShader.replace('void main() {', `varying float interpolated_pick_identifier;\n${encode_identifier_glsl}\nvoid main() {`);
      const closing_brace_index = fragment_shader_with_declarations.lastIndexOf('}');
      shader.fragmentShader = fragment_shader_with_declarations.slice(0, closing_brace_index) + '\n\tgl_FragColor = encode_identifier_as_color(interpolated_pick_identifier);\n}';
    };
    this.pick_line_material.customProgramCacheKey = () => 'vc-pick-line';
    this.depth_only_material = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: clip_planes });
    const create_overlay_surface_material = (overlay_color, roughness, opacity) => new THREE.MeshStandardMaterial({ color: overlay_color, roughness, metalness: 0, transparent: true, opacity, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4, depthWrite: false, clippingPlanes: clip_planes });
    this.overlay_surface_materials = {
      select: create_overlay_surface_material(selection_color, 0.5, 0.92),
      hover: create_overlay_surface_material(ember_color, 0.6, 0.3),
      agent: create_overlay_surface_material(agent_highlight_color, 0.55, 0.55),
    };
    this.overlay_line_materials = {
      select: new LineMaterial({ color: ember_color, linewidth: 3.2, worldUnits: false, clippingPlanes: clip_planes }),
      hover: new LineMaterial({ color: ember_color, linewidth: 2.6, worldUnits: false, transparent: true, opacity: 0.7, clippingPlanes: clip_planes }),
      agent: new LineMaterial({ color: agent_highlight_color, linewidth: 3.2, worldUnits: false, clippingPlanes: clip_planes }),
      measure: new LineMaterial({ color: dimension_color, linewidth: 1.6, worldUnits: false, depthTest: false, transparent: true }),
    };
    this.line_materials = new Set([this.pick_line_material, ...Object.values(this.overlay_line_materials)]);
  }

  create_grid() {
    this.grid_material = new THREE.ShaderMaterial({
      vertexShader: grid_vertex_shader, fragmentShader: grid_fragment_shader, transparent: true, depthWrite: false,
      uniforms: { cell_size: { value: 10 }, fade_center: { value: new THREE.Vector3() }, fade_distance: { value: 1000 }, grid_opacity: { value: 1 } },
      extensions: { derivatives: true },
    });
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.grid_material);
    this.grid.renderOrder = -2;
    this.grid.userData.is_helper = true;
    this.scene.add(this.grid);
  }

  create_contact_shadow() {
    this.blur_material = new THREE.ShaderMaterial({ vertexShader: blur_vertex_shader, fragmentShader: blur_fragment_shader, depthTest: false, depthWrite: false, uniforms: { source_texture: { value: null }, blur_direction: { value: new THREE.Vector2() } } });
    this.fullscreen_quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blur_material);
    this.fullscreen_quad.frustumCulled = false;
    this.fullscreen_camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.shadow_plane = new THREE.Group();
    this.shadow_plane.userData.is_helper = true;
    this.shadow_layers = [
      { texture_size_in_pixels: 512, reach_fraction: 0.06, is_tight_contact_layer: true, depth_falloff_exponent: 1.4, darkness: 1.6, blur_passes_in_texels: [1.2, 0.6], opacity: 0.9 },
      { texture_size_in_pixels: 256, reach_fraction: 0.9, is_tight_contact_layer: false, depth_falloff_exponent: 1.0, darkness: 1.0, blur_passes_in_texels: [3.0, 1.6, 0.8], opacity: 0.5 },
    ].map((shadow_layer) => this.create_shadow_layer(shadow_layer));
    this.floor_glow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: draw_floor_glow_texture(), transparent: true, depthWrite: false, toneMapped: false, opacity: this.options.is_transparent ? 0.5 : 0.22 }));
    this.floor_glow.renderOrder = -1.5;
    this.shadow_plane.add(this.floor_glow);
    this.scene.add(this.shadow_plane);
    this.shadow_needs_render = true;
  }

  create_shadow_layer(shadow_layer) {
    const create_render_target = () => {
      const render_target = new THREE.WebGLRenderTarget(shadow_layer.texture_size_in_pixels, shadow_layer.texture_size_in_pixels);
      render_target.texture.generateMipmaps = false;
      return render_target;
    };
    shadow_layer.render_target = create_render_target();
    shadow_layer.blur_render_target = create_render_target();
    shadow_layer.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    shadow_layer.camera.layers.set(1);
    shadow_layer.depth_material = create_shadow_depth_material(shadow_layer, this.clip_planes);
    shadow_layer.plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadow_layer.render_target.texture, transparent: true, depthWrite: false, opacity: shadow_layer.opacity, side: THREE.DoubleSide, toneMapped: false }));
    shadow_layer.plane.renderOrder = -1;
    this.shadow_plane.add(shadow_layer.plane);
    return shadow_layer;
  }

  create_section_helper() {
    const plane_geometry = new THREE.PlaneGeometry(1, 1);
    const section_fill = new THREE.Mesh(plane_geometry, new THREE.MeshBasicMaterial({ color: ember_color, transparent: true, opacity: 0.04, depthWrite: false, side: THREE.DoubleSide }));
    const section_outline = new THREE.LineSegments(new THREE.EdgesGeometry(plane_geometry), new THREE.LineBasicMaterial({ color: ember_color, transparent: true, opacity: 0.7 }));
    this.section_helper = new THREE.Group();
    this.section_helper.add(section_fill, section_outline);
    this.section_helper.visible = false;
    this.section_helper.userData.is_helper = true;
    this.scene.add(this.section_helper);
  }

  create_view_cube() {
    const view_cube = this.view_cube = { size_in_pixels: 100, margin_in_pixels: 10, scene: new THREE.Scene(), group: new THREE.Group(), regions: [], hovered_region_key: null, label_textures: [] };
    view_cube.camera = new THREE.OrthographicCamera(-2.05, 2.05, 2.05, -2.05, 0.1, 20);
    view_cube.scene.add(view_cube.group);
    const edge_material_by_region_key = new Map();
    const cube_faces = [
      ['FRONT', [0, -1, 0], [1, 0, 0], [0, 0, 1]],
      ['BACK', [0, 1, 0], [-1, 0, 0], [0, 0, 1]],
      ['RIGHT', [1, 0, 0], [0, 1, 0], [0, 0, 1]],
      ['LEFT', [-1, 0, 0], [0, -1, 0], [0, 0, 1]],
      ['TOP', [0, 0, 1], [1, 0, 0], [0, 1, 0]],
      ['BOTTOM', [0, 0, -1], [1, 0, 0], [0, -1, 0]],
    ];
    for (const [face_label, ...face_frame] of cube_faces) {
      for (const region_steps of cube_region_steps) view_cube.regions.push(this.create_view_cube_region(face_label, face_frame.map(vector_from_array), region_steps, edge_material_by_region_key));
    }
    view_cube.group.add(...view_cube.regions);
    view_cube.group.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2, 2, 2)), new THREE.LineBasicMaterial({ color: 0x6e605d, toneMapped: false })));
    this.add_view_cube_axis_triad();
    document.fonts?.ready?.then(() => {
      for (const [label_texture, face_label] of view_cube.label_textures) { draw_cube_face_label(label_texture.image, face_label); label_texture.needsUpdate = true; }
      this.needs_render = true;
    });
  }

  create_view_cube_region(face_label, [face_normal, face_right, face_up], [right_step, up_step], edge_material_by_region_key) {
    const region_direction = face_normal.clone().addScaledVector(face_right, right_step).addScaledVector(face_up, up_step).round();
    const region_key = region_direction.toArray().join(',');
    const [left_edge, right_edge] = cube_region_span_by_step[right_step], [bottom_edge, top_edge] = cube_region_span_by_step[up_step];
    const corner_offsets = [[left_edge, bottom_edge], [right_edge, bottom_edge], [right_edge, top_edge], [left_edge, top_edge]];
    const region_geometry = new THREE.BufferGeometry();
    region_geometry.setAttribute('position', new THREE.Float32BufferAttribute(corner_offsets.flatMap(([along_right, along_up]) => face_normal.clone().addScaledVector(face_right, along_right).addScaledVector(face_up, along_up).toArray()), 3));
    region_geometry.setAttribute('uv', new THREE.Float32BufferAttribute(corner_offsets.flatMap((corner_offset) => corner_offset.map((offset) => (offset - (-1 + cube_corner_bevel)) / (2 - 2 * cube_corner_bevel))), 2));
    region_geometry.setIndex([0, 1, 2, 0, 2, 3]);
    if (!edge_material_by_region_key.has(region_key)) edge_material_by_region_key.set(region_key, new THREE.MeshBasicMaterial({ color: cube_edge_region_rest_color, toneMapped: false }));
    const is_face_center = !right_step && !up_step;
    const region_mesh = new THREE.Mesh(region_geometry, is_face_center ? this.create_cube_face_material(face_label) : edge_material_by_region_key.get(region_key));
    region_mesh.userData = { direction: region_direction.toArray(), region_key };
    return region_mesh;
  }

  create_cube_face_material(face_label) {
    const label_texture = create_cube_face_label_texture(face_label);
    this.view_cube.label_textures.push([label_texture, face_label]);
    return new THREE.MeshBasicMaterial({ map: label_texture, color: cube_face_rest_color.clone(), toneMapped: false });
  }

  add_view_cube_axis_triad() {
    const triad_origin = new THREE.Vector3(-1.32, -1.32, -1.32);
    for (const [axis_direction, axis_color, axis_letter] of [[[1, 0, 0], 0xff5a4a, 'X'], [[0, 1, 0], 0x86c96f, 'Y'], [[0, 0, 1], 0x6b95ff, 'Z']]) {
      const axis_end = triad_origin.clone().addScaledVector(vector_from_array(axis_direction), 1.25);
      this.view_cube.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([triad_origin, axis_end]), new THREE.LineBasicMaterial({ color: axis_color, toneMapped: false })));
      const axis_label = new THREE.Sprite(new THREE.SpriteMaterial({ map: create_axis_letter_texture(axis_letter, axis_color), toneMapped: false, depthTest: false }));
      axis_label.position.copy(axis_end).addScaledVector(vector_from_array(axis_direction), 0.22);
      axis_label.scale.setScalar(0.42);
      this.view_cube.group.add(axis_label);
    }
  }

  create_overlay() {
    this.label_layer = create_element('div', 'vc-labels');
    this.tooltip_element = create_element('div', 'vc-tip');
    this.toast_element = create_element('div', 'vc-toast');
    this.overlay_element = create_element('div', 'vc-overlay');
    this.overlay_element.append(this.label_layer, this.tooltip_element, this.toast_element);
    this.container_element.appendChild(this.overlay_element);
    this.help_element = create_element('div', 'vc-help', `
      <div class="vc-help-card">
        <div class="vc-help-head"><span>Keyboard</span><button class="vc-x" aria-label="Close">×</button></div>
        <div class="vc-help-grid">
          <kbd>F</kbd><span>Fit to view</span>
          <kbd>1–7</kbd><span>Iso · Front · Back · Left · Right · Top · Bottom</span>
          <kbd>P</kbd><span>Perspective / orthographic</span>
          <kbd>S</kbd><span>Section plane</span>
          <kbd>M</kbd><span>Measure</span>
          <kbd>X</kbd><span>Explode assembly</span>
          <kbd>W</kbd><span>Cycle render mode</span>
          <kbd>B</kbd><span>Bounding box dimensions</span>
          <kbd>Esc</kbd><span>Clear selection</span>
          <kbd>?</kbd><span>This help</span>
        </div>
        <div class="vc-help-head" style="margin-top:18px"><span>Mouse</span></div>
        <div class="vc-help-grid">
          <kbd>Drag</kbd><span>Orbit</span>
          <kbd>Right / middle drag</kbd><span>Pan</span>
          <kbd>Wheel</kbd><span>Zoom to cursor</span>
          <kbd>Click</kbd><span>Select face / edge &nbsp;·&nbsp; Shift adds</span>
          <kbd>Double-click</kbd><span>Set orbit pivot &nbsp;·&nbsp; Alt: look normal to face</span>
        </div>
      </div>`);
    this.help_element.addEventListener('click', (click_event) => { if (click_event.target === this.help_element || click_event.target.closest('.vc-x')) this.toggle_help(false); });
    this.container_element.appendChild(this.help_element);
  }

  canvas_position_of(pointer_event) {
    const canvas_rectangle = this.renderer.domElement.getBoundingClientRect();
    return [pointer_event.clientX - canvas_rectangle.left, pointer_event.clientY - canvas_rectangle.top];
  }

  listen_to_pointer() {
    const canvas = this.renderer.domElement;
    this.pointer = { canvas_x_in_pixels: 0, canvas_y_in_pixels: 0, is_inside: false };
    let pointer_down = null;
    canvas.addEventListener('pointerdown', (pointer_event) => { pointer_down = { client_x: pointer_event.clientX, client_y: pointer_event.clientY, time_in_milliseconds: performance.now(), button: pointer_event.button }; });
    canvas.addEventListener('pointerup', (pointer_event) => {
      const was_click = pointer_down && pointer_down.button === 0 && Math.hypot(pointer_event.clientX - pointer_down.client_x, pointer_event.clientY - pointer_down.client_y) < click_movement_tolerance_in_pixels && performance.now() - pointer_down.time_in_milliseconds < longest_click_in_milliseconds;
      pointer_down = null;
      if (was_click) this.handle_click(pointer_event);
    });
    canvas.addEventListener('pointermove', (pointer_event) => {
      const [canvas_x_in_pixels, canvas_y_in_pixels] = this.canvas_position_of(pointer_event);
      this.pointer = { canvas_x_in_pixels, canvas_y_in_pixels, is_inside: true };
      if (!pointer_event.buttons) this.hover_needs_update = true;
    });
    canvas.addEventListener('pointerleave', () => {
      this.pointer.is_inside = false;
      this.set_hovered_entity(null);
      this.set_view_cube_hover(null);
    });
    canvas.addEventListener('dblclick', (pointer_event) => this.handle_double_click(pointer_event));
    canvas.addEventListener('contextmenu', (pointer_event) => pointer_event.preventDefault());
  }

  create_shortcut_actions() {
    const view_shortcuts = view_names_in_shortcut_order.map((view_name, view_index) => [String(view_index + 1), () => this.set_view(view_name)]);
    return {
      ...Object.fromEntries(view_shortcuts),
      0: () => this.set_view('iso'),
      f: () => this.fit(),
      s: () => this.set_section({ is_enabled: !this.state.section.is_enabled }),
      m: () => this.toggle_measure_tool(),
      x: () => this.animate_explode(this.state.explode_fraction > 0.01 ? 0 : 0.6),
      w: () => this.cycle_render_mode(),
      p: () => this.toggle_projection(),
      b: () => this.set_bounding_box(!this.state.show_bounding_box),
      Escape: () => this.step_back_from_current_interaction(),
      '?': () => this.toggle_help(),
    };
  }

  handle_shortcut_key(key_event) {
    if (key_event.target?.closest?.('input,textarea,select,[contenteditable="true"],.CodeMirror')) return;
    if (key_event.metaKey || key_event.ctrlKey || key_event.altKey) return;
    if (!this.container_element.offsetParent && getComputedStyle(this.container_element).position !== 'fixed') return;
    const shortcut_action = this.shortcut_actions[key_event.key] || this.shortcut_actions[(key_event.key || '').toLowerCase()];
    if (!shortcut_action) return;
    shortcut_action();
    key_event.preventDefault();
  }

  step_back_from_current_interaction() {
    if (this.help_element.classList.contains('on')) return this.toggle_help(false);
    if (this.state.tool === 'measure' && this.measure_picks.length) return this.clear_measure();
    if (this.state.tool !== 'select') return this.set_tool('select');
    this.clear_selection();
  }

  cycle_render_mode() {
    const current_mode_index = render_modes_with_labels.findIndex(([render_mode]) => render_mode === this.state.render_mode);
    const [next_render_mode, next_render_mode_label] = render_modes_with_labels[(current_mode_index + 1) % render_modes_with_labels.length];
    this.set_render_mode(next_render_mode);
    this.flash(next_render_mode_label);
  }

  async load(scene_url) {
    const http_response = await fetch(scene_url);
    if (!http_response.ok) throw new Error(`HTTP ${http_response.status} loading scene`);
    const scene = await http_response.json();
    this.load_scene(scene);
    return scene;
  }

  load_scene(scene, { keep_camera = false, version_id = null } = {}) {
    if (!scene || !Array.isArray(scene.parts)) throw new Error('not a biscad scene');
    const previous_selection = this.selection.slice();
    const previously_hidden_part_ids = new Set(this.parts.filter((part) => !part.visible).map((part) => part.id));
    const keeps_same_part_count = keep_camera && this.parts.length === scene.parts.length;
    this.clear_parts();
    this.loaded_scene = scene;
    this.version_id = version_id;
    this.pick_table = [null];
    this.parts = scene.parts.map((scene_part, part_index) => this.build_part(scene_part, part_index));
    for (const part of this.parts) {
      if (keeps_same_part_count && previously_hidden_part_ids.has(part.id)) this.set_part_visibility_flag(part, false);
      this.root.add(part.group);
    }
    const model_box = this.parts.reduce((union_box, part) => union_box.union(part.bounding_box), new THREE.Box3());
    if (model_box.isEmpty()) model_box.set(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
    this.model_box = model_box;
    this.model_center = model_box.getCenter(new THREE.Vector3());
    this.model_diagonal = Math.max(model_box.getSize(new THREE.Vector3()).length(), 1e-3);
    this.triangle_count = this.parts.reduce((total_triangles, part) => total_triangles + part.triangle_count, 0);
    this.compute_explode_directions();
    this.apply_explode();
    this.layout_ground();
    this.set_render_mode(this.state.render_mode, true);
    if (this.state.section.is_enabled) this.apply_section();
    if (!keep_camera) this.fit(false, 'iso');
    this.reset_measurement();
    this.selection = previous_selection.filter((entity_id) => this.get_entity(entity_id));
    this.highlighted_ids = this.highlighted_ids.filter((entity_id) => this.get_entity(entity_id));
    this.refresh_overlays();
    this.shadow_needs_render = true;
    this.dispatchEvent(new CustomEvent('load', { detail: { scene, statistics: this.describe_model_statistics() } }));
    this.emit_selection_change();
  }

  register_pickable_entity(part_index, entity_kind, entity_index) {
    this.pick_table.push({ part_index, entity_kind, entity_index });
    return this.pick_table.length - 1;
  }

  build_part(scene_part, part_index) {
    const positions = decode_float32_array(scene_part.positions), triangle_indices = decode_uint32_array(scene_part.indices);
    const faces = scene_part.faces || [], edges = scene_part.edges || [];
    const geometry = this.build_part_geometry(positions, decode_float32_array(scene_part.normals), triangle_indices, faces, part_index);
    const part_color = new THREE.Color(scene_part.color || default_part_color);
    const is_dark_part = part_color.getHSL({}).l < 0.12;
    const solid_material = new THREE.MeshPhysicalMaterial({
      color: part_color, roughness: is_dark_part ? 0.38 : 0.46, metalness: is_dark_part ? 0.2 : 0.04,
      clearcoat: is_dark_part ? 0.4 : 0.3, clearcoatRoughness: 0.38, envMapIntensity: is_dark_part ? 1.15 : 0.95,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: this.clip_planes,
    });
    const xray_material = new THREE.MeshPhysicalMaterial({ color: part_color, roughness: 0.5, metalness: 0, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: this.clip_planes });
    const mesh = new THREE.Mesh(geometry, solid_material);
    mesh.layers.enable(1);
    const cap_material = create_section_cap_material(part_color, is_dark_part, this.clip_planes);
    const cap = new THREE.Mesh(geometry, cap_material);
    cap.visible = false;
    cap.renderOrder = 1;
    const edge_lines = this.build_part_edge_lines(edges, part_index, is_dark_part);
    const overlays = new THREE.Group();
    overlays.userData.excluded_from_ambient_occlusion = true;
    const group = new THREE.Group();
    group.add(mesh, cap, ...(edge_lines.lines ? [edge_lines.lines] : []), overlays);
    return {
      id: scene_part.id || `p${part_index}`, name: scene_part.name || `part ${part_index}`, color: scene_part.color || default_part_color, index: part_index, visible: true,
      faces, edges, face_by_id: new Map(faces.map((face) => [face.id, face])), edge_by_id: new Map(edges.map((edge) => [edge.id, edge])),
      ...edge_lines, geometry, mesh, cap, solid_material, xray_material, cap_material, group, overlays,
      triangle_count: triangle_indices.length / 3, bounding_box: geometry.boundingBox.clone(), explode_offset: new THREE.Vector3(),
      area_in_square_millimeters: faces.reduce((total_area, face) => total_area + (face.area || 0), 0), volume_in_cubic_millimeters: Math.abs(compute_signed_mesh_volume(positions, triangle_indices)),
    };
  }

  build_part_geometry(positions, normals, triangle_indices, faces, part_index) {
    const geometry = new THREE.BufferGeometry();
    const has_matching_normals = normals.length === positions.length;
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    if (has_matching_normals) geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(triangle_indices, 1));
    if (!has_matching_normals) geometry.computeVertexNormals();
    const pick_identifier_per_vertex = new Float32Array(positions.length / 3);
    faces.forEach((face, face_index) => {
      const pick_identifier = this.register_pickable_entity(part_index, 'face', face_index);
      for (let index_position = face.start * 3; index_position < (face.start + face.count) * 3; index_position++) pick_identifier_per_vertex[triangle_indices[index_position]] = pick_identifier;
    });
    geometry.setAttribute('pick_identifier', new THREE.BufferAttribute(pick_identifier_per_vertex, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  build_part_edge_lines(edges, part_index, is_dark_part) {
    const segment_coordinate_lists = [], segment_pick_identifier_lists = [], segment_range_by_edge_id = new Map();
    let segment_count = 0;
    edges.forEach((edge, edge_index) => {
      const pick_identifier = this.register_pickable_entity(part_index, 'edge', edge_index);
      const edge_segment_coordinates = flatten_polyline_into_segments(edge_polyline_points(edge));
      const edge_segment_count = edge_segment_coordinates.length / 6;
      segment_range_by_edge_id.set(edge.id, [segment_count, edge_segment_count]);
      segment_coordinate_lists.push(edge_segment_coordinates);
      segment_pick_identifier_lists.push(new Array(edge_segment_count).fill(pick_identifier));
      segment_count += edge_segment_count;
    });
    const segment_positions = new Float32Array(segment_coordinate_lists.flat());
    if (!segment_count) return { segment_positions, segment_range_by_edge_id, lines: null, line_material: null };
    const line_geometry = new LineSegmentsGeometry();
    line_geometry.setPositions(segment_positions);
    line_geometry.setAttribute('instance_edge_identifier', new THREE.InstancedBufferAttribute(new Float32Array(segment_pick_identifier_lists.flat()), 1));
    const line_material = new LineMaterial({ color: is_dark_part ? 0x7d6e6b : 0x120c0d, linewidth: 1.15, worldUnits: false, transparent: true, opacity: is_dark_part ? 0.7 : 0.78, clippingPlanes: this.clip_planes });
    this.line_materials.add(line_material);
    const lines = new LineSegments2(line_geometry, line_material);
    lines.renderOrder = 2;
    lines.userData.excluded_from_ambient_occlusion = true;
    return { segment_positions, segment_range_by_edge_id, lines, line_material };
  }

  clear_parts() {
    for (const part of this.parts) {
      part.geometry.dispose();
      part.lines?.geometry.dispose();
      [part.solid_material, part.xray_material, part.cap_material, part.line_material].forEach((material) => material?.dispose());
      this.line_materials.delete(part.line_material);
      this.dispose_overlays(part);
      this.root.remove(part.group);
    }
    this.parts = [];
    this.loaded_scene = null;
  }

  dispose_overlays(part) {
    for (const overlay_object of part.overlays.children.slice()) {
      if (overlay_object.isLineSegments2) overlay_object.geometry.dispose();
      part.overlays.remove(overlay_object);
    }
  }

  clear() {
    this.clear_parts();
    this.set_ghost(null);
    this.selection = [];
    this.highlighted_ids = [];
    this.clear_screen_labels('measure');
    this.clear_screen_labels('bbox');
    this.needs_render = true;
  }

  layout_ground() {
    const visible_box = this.visible_box();
    const visible_size = visible_box.getSize(new THREE.Vector3());
    const visible_center = visible_box.getCenter(new THREE.Vector3());
    const visible_diagonal = Math.max(visible_size.length(), 1e-3);
    const ground_height = visible_box.min.z - visible_diagonal * 0.0015;
    const grid_uniforms = this.grid_material.uniforms;
    grid_uniforms.cell_size.value = Math.pow(10, Math.floor(Math.log10(Math.max(visible_diagonal / 8, 1e-3))));
    grid_uniforms.fade_center.value.copy(visible_center);
    grid_uniforms.fade_distance.value = visible_diagonal * 1.35;
    this.grid.scale.set(visible_diagonal * 12, visible_diagonal * 12, 1);
    this.grid.position.set(visible_center.x, visible_center.y, ground_height - visible_diagonal * 0.0005);
    const shadow_width = Math.max(visible_size.x, visible_size.y) * 1.25 + visible_diagonal * 0.35;
    this.floor_glow.scale.set(shadow_width * 1.5, shadow_width * 1.5, 1);
    this.floor_glow.position.set(visible_center.x, visible_center.y, ground_height - visible_diagonal * 0.0003);
    for (const shadow_layer of this.shadow_layers) layout_shadow_layer(shadow_layer, { visible_center, visible_size, visible_diagonal, ground_height, shadow_width });
    this.shadow_needs_render = true;
    this.grid.visible = this.state.show_grid;
    this.shadow_plane.visible = this.state.show_shadow;
  }

  render_into_target(render_target, scene, camera) {
    this.renderer.setRenderTarget(render_target);
    this.renderer.clear();
    this.renderer.render(scene, camera);
  }

  render_contact_shadows() {
    const renderer = this.renderer;
    const saved_background = this.scene.background, saved_clear_alpha = renderer.getClearAlpha(), saved_clear_color = renderer.getClearColor(new THREE.Color());
    this.scene.background = null;
    renderer.setClearColor(0x000000, 0);
    for (const shadow_layer of this.shadow_layers) {
      this.scene.overrideMaterial = shadow_layer.depth_material;
      this.render_into_target(shadow_layer.render_target, this.scene, shadow_layer.camera);
      this.scene.overrideMaterial = null;
      shadow_layer.blur_passes_in_texels.forEach((blur_amount_in_texels) => this.blur_shadow_layer(shadow_layer, blur_amount_in_texels / shadow_layer.texture_size_in_pixels));
    }
    renderer.setRenderTarget(null);
    renderer.setClearColor(saved_clear_color, saved_clear_alpha);
    this.scene.background = saved_background;
    this.shadow_needs_render = false;
  }

  blur_shadow_layer(shadow_layer, blur_step_in_texture_units) {
    const blur_uniforms = this.blur_material.uniforms;
    blur_uniforms.source_texture.value = shadow_layer.render_target.texture;
    blur_uniforms.blur_direction.value.set(blur_step_in_texture_units, 0);
    this.render_into_target(shadow_layer.blur_render_target, this.fullscreen_quad, this.fullscreen_camera);
    blur_uniforms.source_texture.value = shadow_layer.blur_render_target.texture;
    blur_uniforms.blur_direction.value.set(0, blur_step_in_texture_units);
    this.render_into_target(shadow_layer.render_target, this.fullscreen_quad, this.fullscreen_camera);
  }

  resize_to_container() {
    const viewport_width_in_pixels = this.viewport_width_in_pixels = Math.max(this.container_element.clientWidth, 1);
    const viewport_height_in_pixels = this.viewport_height_in_pixels = Math.max(this.container_element.clientHeight, 1);
    this.renderer.setSize(viewport_width_in_pixels, viewport_height_in_pixels, false);
    Object.assign(this.renderer.domElement.style, { width: viewport_width_in_pixels + 'px', height: viewport_height_in_pixels + 'px' });
    this.perspective_camera.aspect = viewport_width_in_pixels / viewport_height_in_pixels;
    this.perspective_camera.updateProjectionMatrix();
    this.update_orthographic_frustum();
    for (const line_material of this.line_materials) if (line_material !== this.pick_line_material) line_material.resolution.set(viewport_width_in_pixels, viewport_height_in_pixels);
    this.composer?.setSize(viewport_width_in_pixels, viewport_height_in_pixels);
    this.ambient_occlusion_pass?.setSize?.(viewport_width_in_pixels, viewport_height_in_pixels);
    if (this.view_cube) this.view_cube.size_in_pixels = viewport_width_in_pixels < 520 ? 84 : 112;
    this.needs_render = true;
  }

  update_orthographic_frustum() {
    const view_height = this.orthographic_view_height || 100;
    const aspect_ratio = (this.viewport_width_in_pixels || 1) / (this.viewport_height_in_pixels || 1);
    Object.assign(this.orthographic_camera, { left: -view_height * aspect_ratio / 2, right: view_height * aspect_ratio / 2, top: view_height / 2, bottom: -view_height / 2 }).updateProjectionMatrix();
  }

  animate_frame(frame_time_in_milliseconds) {
    requestAnimationFrame(this.animate_frame);
    if (this.camera_flight) this.step_camera_flight(frame_time_in_milliseconds);
    if (this.explode_animation) this.step_explode_animation(frame_time_in_milliseconds);
    if (this.controls.update()) this.needs_render = true;
    if (this.hover_needs_update && this.pointer.is_inside) {
      this.hover_needs_update = false;
      this.update_hover();
    }
    if (this.needs_render) this.render();
  }

  render() {
    this.needs_render = false;
    const camera = this.camera;
    this.update_camera_clip_distances(camera);
    this.light_rig.position.copy(camera.position);
    this.light_rig.quaternion.copy(camera.quaternion);
    if (this.state.show_shadow && this.shadow_needs_render && this.parts.length) this.render_contact_shadows();
    this.renderer.setRenderTarget(null);
    if (this.composer && this.state.ambient_occlusion_enabled && !this.state.section.is_enabled) {
      this.render_pass.camera = camera;
      this.ambient_occlusion_pass.camera = camera;
      this.composer.render();
    } else this.renderer.render(this.scene, camera);
    if (this.view_cube && !this.is_view_cube_hidden) this.render_view_cube();
    this.update_screen_labels();
  }

  update_camera_clip_distances(camera) {
    const distance_to_target = camera.position.distanceTo(this.controls.target);
    const model_diagonal = this.model_diagonal || 100;
    if (camera.isPerspectiveCamera) {
      const near_distance = Math.max(distance_to_target * 0.01, model_diagonal * 1e-5), far_distance = distance_to_target + model_diagonal * 30;
      const has_drifted = Math.abs(near_distance - camera.near) / camera.near > 0.05 || Math.abs(far_distance - camera.far) / camera.far > 0.05;
      if (has_drifted) Object.assign(camera, { near: near_distance, far: far_distance }).updateProjectionMatrix();
      return;
    }
    const orthographic_depth_margin = model_diagonal * 40;
    if (camera.far !== distance_to_target + orthographic_depth_margin) Object.assign(camera, { near: -orthographic_depth_margin, far: distance_to_target + orthographic_depth_margin }).updateProjectionMatrix();
  }

  view_cube_rectangle() {
    const { size_in_pixels, margin_in_pixels } = this.view_cube;
    return { size_in_pixels, left_in_pixels: this.viewport_width_in_pixels - size_in_pixels - margin_in_pixels, top_in_pixels: margin_in_pixels + (this.options.view_cube_top_offset_in_pixels || 0) };
  }

  render_view_cube() {
    const renderer = this.renderer, view_cube = this.view_cube;
    view_cube.camera.position.copy(this.camera_offset_from_target().normalize()).multiplyScalar(8);
    view_cube.camera.up.copy(this.camera.up);
    view_cube.camera.lookAt(0, 0, 0);
    const { size_in_pixels, left_in_pixels, top_in_pixels } = this.view_cube_rectangle();
    const bottom_in_pixels = this.viewport_height_in_pixels - top_in_pixels - size_in_pixels;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setViewport(left_in_pixels, bottom_in_pixels, size_in_pixels, size_in_pixels);
    renderer.setScissor(left_in_pixels, bottom_in_pixels, size_in_pixels, size_in_pixels);
    renderer.clearDepth();
    renderer.render(view_cube.scene, view_cube.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, this.viewport_width_in_pixels, this.viewport_height_in_pixels);
    renderer.autoClear = true;
  }

  find_view_cube_region_at(canvas_x_in_pixels, canvas_y_in_pixels) {
    if (!this.view_cube) return null;
    const { size_in_pixels, left_in_pixels, top_in_pixels } = this.view_cube_rectangle();
    const is_outside_cube = canvas_x_in_pixels < left_in_pixels || canvas_x_in_pixels > left_in_pixels + size_in_pixels || canvas_y_in_pixels < top_in_pixels || canvas_y_in_pixels > top_in_pixels + size_in_pixels;
    if (is_outside_cube) return null;
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(((canvas_x_in_pixels - left_in_pixels) / size_in_pixels) * 2 - 1, -((canvas_y_in_pixels - top_in_pixels) / size_in_pixels) * 2 + 1), this.view_cube.camera);
    return raycaster.intersectObjects(this.view_cube.regions, false)[0]?.object || 'background';
  }

  set_view_cube_hover(hovered_region) {
    if (!this.view_cube) return;
    const hovered_region_key = hovered_region?.userData?.region_key || null;
    if (hovered_region_key === this.view_cube.hovered_region_key) return;
    this.view_cube.hovered_region_key = hovered_region_key;
    for (const region of this.view_cube.regions) {
      const is_hovered = region.userData.region_key === hovered_region_key;
      if (region.material.map) region.material.color.copy(is_hovered ? cube_face_hover_color : cube_face_rest_color);
      else region.material.color.set(is_hovered ? cube_edge_region_hover_color : cube_edge_region_rest_color);
    }
    this.renderer.domElement.style.cursor = hovered_region_key ? 'pointer' : '';
    this.needs_render = true;
  }

  camera_offset_from_target() {
    return new THREE.Vector3().subVectors(this.camera.position, this.controls.target);
  }

  visible_box() {
    const union_box = this.parts.filter((part) => part.visible).reduce((box, part) => box.union(part.bounding_box.clone().translate(part.explode_offset)), new THREE.Box3());
    if (!union_box.isEmpty()) return union_box;
    return this.model_box ? this.model_box.clone() : new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));
  }

  compute_fit_for_box(box) {
    const bounding_sphere = box.getBoundingSphere(new THREE.Sphere());
    const sphere_radius = Math.max(bounding_sphere.radius, 1e-3);
    const vertical_field_of_view_in_radians = THREE.MathUtils.degToRad(this.perspective_camera.fov);
    const aspect_ratio = this.viewport_width_in_pixels / this.viewport_height_in_pixels;
    const narrowest_field_of_view_in_radians = aspect_ratio < 1 ? 2 * Math.atan(Math.tan(vertical_field_of_view_in_radians / 2) * aspect_ratio) : vertical_field_of_view_in_radians;
    const fit_margin_factor = this.options.fit_margin_factor || 1;
    const view_height = this.orthographic_view_height;
    return {
      target: bounding_sphere.center,
      distance: (sphere_radius / Math.sin(narrowest_field_of_view_in_radians / 2)) * 1.02 * fit_margin_factor,
      zoom: Math.min(view_height / (2 * sphere_radius), (view_height * aspect_ratio) / (2 * sphere_radius)) / (1.1 * fit_margin_factor),
    };
  }

  fly_to_fitted_view(view_direction, should_animate = true) {
    const visible_box = this.visible_box();
    const { target, distance, zoom } = this.compute_fit_for_box(visible_box);
    this.fly_to(target, view_direction, distance, zoom, should_animate);
  }

  fit(should_animate = true, view_name = null) {
    if (!this.orthographic_view_height || !should_animate) this.orthographic_view_height = Math.max(this.visible_box().getSize(new THREE.Vector3()).length() * 1.2, 1e-2);
    this.update_orthographic_frustum();
    this.fly_to_fitted_view(view_name ? vector_from_array(view_directions[view_name]).normalize() : this.camera_offset_from_target().normalize(), should_animate);
  }

  set_view(view_name, should_animate = true) {
    if (view_directions[view_name]) this.fly_to_fitted_view(vector_from_array(view_directions[view_name]).normalize(), should_animate);
  }

  fly_to(target, view_direction, distance, zoom, should_animate = true) {
    const destination = { target: target.clone(), direction: view_direction.clone().normalize(), distance, zoom };
    if (should_animate) {
      const current_offset = this.camera_offset_from_target();
      const origin = { target: this.controls.target.clone(), distance: current_offset.length() || distance, direction: current_offset.normalize(), zoom: this.orthographic_camera.zoom };
      this.camera_flight = { start_time_in_milliseconds: performance.now(), origin, destination };
      return;
    }
    this.apply_camera_pose(destination.target, destination.direction, distance, this.camera.isOrthographicCamera ? zoom : null);
    this.set_orthographic_zoom(zoom);
    this.needs_render = true;
  }

  set_orthographic_zoom(zoom) {
    this.orthographic_camera.zoom = zoom;
    this.orthographic_camera.updateProjectionMatrix();
  }

  apply_camera_pose(target, view_direction, distance, zoom) {
    const camera = this.camera;
    this.controls.target.copy(target);
    camera.position.copy(target).addScaledVector(view_direction, camera.isOrthographicCamera ? Math.max(distance, (this.model_diagonal || 100) * 2) : distance);
    camera.lookAt(target);
    if (zoom != null && camera.isOrthographicCamera) this.set_orthographic_zoom(zoom);
    if (camera !== this.perspective_camera) {
      this.perspective_camera.position.copy(target).addScaledVector(view_direction, distance);
      this.perspective_camera.lookAt(target);
    }
    this.controls.update();
  }

  step_camera_flight(now_in_milliseconds) {
    const { start_time_in_milliseconds, origin, destination } = this.camera_flight;
    const progress_fraction = Math.min((now_in_milliseconds - start_time_in_milliseconds) / camera_flight_duration_in_milliseconds, 1);
    const eased_fraction = ease_in_out_cubic(progress_fraction);
    const zoom = origin.zoom * Math.pow(destination.zoom / origin.zoom, eased_fraction);
    const view_direction = interpolate_direction_on_sphere(origin.direction, destination.direction, eased_fraction, new THREE.Vector3());
    this.apply_camera_pose(origin.target.clone().lerp(destination.target, eased_fraction), view_direction, origin.distance * Math.pow(destination.distance / origin.distance, eased_fraction), zoom);
    if (this.camera !== this.orthographic_camera) this.set_orthographic_zoom(zoom);
    this.needs_render = true;
    if (progress_fraction >= 1) this.camera_flight = null;
  }

  toggle_projection() {
    this.set_projection(this.state.projection === 'perspective' ? 'orthographic' : 'perspective');
  }

  set_projection(projection_mode) {
    if (projection_mode === this.state.projection) return;
    const view_offset = this.camera_offset_from_target();
    const distance_to_target = view_offset.length();
    view_offset.normalize();
    const half_field_of_view_tangent = Math.tan(THREE.MathUtils.degToRad(this.perspective_camera.fov) / 2);
    if (!this.orthographic_view_height) this.orthographic_view_height = (this.model_diagonal || 100) * 1.2;
    const is_orthographic = projection_mode === 'orthographic';
    const next_camera = is_orthographic ? this.orthographic_camera : this.perspective_camera;
    if (is_orthographic) {
      this.orthographic_camera.position.copy(this.controls.target).addScaledVector(view_offset, Math.max(distance_to_target, this.model_diagonal * 2));
      this.set_orthographic_zoom(this.orthographic_view_height / (2 * distance_to_target * half_field_of_view_tangent));
    } else this.perspective_camera.position.copy(this.controls.target).addScaledVector(view_offset, this.orthographic_view_height / (2 * this.orthographic_camera.zoom * half_field_of_view_tangent));
    next_camera.quaternion.copy(this.camera.quaternion);
    this.camera = next_camera;
    this.update_orthographic_frustum();
    this.controls.object = this.camera;
    this.controls.update();
    this.state.projection = projection_mode;
    this.emit_state_change();
  }

  swap_scene_into_picking_mode() {
    const material_swaps = [], hidden_objects = [];
    const hide_if_visible = (scene_object) => {
      if (!scene_object.visible) return;
      hidden_objects.push(scene_object);
      scene_object.visible = false;
    };
    [this.grid, this.shadow_plane, this.section_helper, this.helpers, this.ghost_root].forEach(hide_if_visible);
    for (const part of this.parts.filter((candidate_part) => candidate_part.visible)) {
      if (part.mesh.visible) material_swaps.push([part.mesh, part.mesh.material, this.pick_material]);
      if (part.lines?.visible) material_swaps.push([part.lines, part.lines.material, this.pick_line_material]);
      hide_if_visible(part.cap);
      hide_if_visible(part.overlays);
    }
    material_swaps.forEach(([scene_object, , pick_material]) => { scene_object.material = pick_material; });
    return () => {
      material_swaps.forEach(([scene_object, original_material]) => { scene_object.material = original_material; });
      hidden_objects.forEach((scene_object) => { scene_object.visible = true; });
    };
  }

  pick_entity_id_at(canvas_x_in_pixels, canvas_y_in_pixels) {
    if (!this.parts.length) return null;
    const renderer = this.renderer, camera = this.camera;
    const restore_scene_after_picking = this.swap_scene_into_picking_mode();
    const saved_background = this.scene.background, saved_clear_color = renderer.getClearColor(new THREE.Color()), saved_clear_alpha = renderer.getClearAlpha();
    this.scene.background = null;
    renderer.setClearColor(0x000000, 1);
    this.pick_line_material.resolution.set(1, 1);
    camera.setViewOffset(this.viewport_width_in_pixels, this.viewport_height_in_pixels, Math.floor(canvas_x_in_pixels), Math.floor(canvas_y_in_pixels), 1, 1);
    this.render_into_target(this.pick_render_target, this.scene, camera);
    renderer.readRenderTargetPixels(this.pick_render_target, 0, 0, 1, 1, this.picked_pixel_bytes);
    renderer.setRenderTarget(null);
    camera.clearViewOffset();
    renderer.setClearColor(saved_clear_color, saved_clear_alpha);
    this.scene.background = saved_background;
    restore_scene_after_picking();
    const [red_byte, green_byte, blue_byte] = this.picked_pixel_bytes;
    const picked_entry = this.pick_table?.[red_byte * 65536 + green_byte * 256 + blue_byte];
    if (!picked_entry) return null;
    const picked_part = this.parts[picked_entry.part_index];
    return (picked_entry.entity_kind === 'face' ? picked_part.faces : picked_part.edges)[picked_entry.entity_index]?.id ?? null;
  }

  update_hover() {
    const { canvas_x_in_pixels, canvas_y_in_pixels } = this.pointer;
    const hovered_cube_region = this.find_view_cube_region_at(canvas_x_in_pixels, canvas_y_in_pixels);
    this.set_view_cube_hover(hovered_cube_region);
    if (hovered_cube_region) return this.set_hovered_entity(null);
    if (this.options.is_interactive) this.set_hovered_entity(this.pick_entity_id_at(canvas_x_in_pixels, canvas_y_in_pixels));
  }

  set_hovered_entity(entity_id) {
    const is_unchanged = entity_id === this.hovered_id;
    if (is_unchanged && entity_id) this.move_tooltip();
    if (is_unchanged) return;
    this.hovered_id = entity_id;
    this.refresh_overlays();
    this.renderer.domElement.style.cursor = entity_id ? 'pointer' : '';
    if (entity_id) this.show_tooltip(entity_id);
    else this.hide_tooltip();
  }

  show_tooltip(entity_id) {
    const entity = this.get_entity(entity_id);
    if (!entity) return;
    this.tooltip_element.innerHTML = `<b>${entity_id}</b><span>${entity.kind === 'part' ? 'part' : entity.type}</span><span>${describe_entity_size(entity)}</span>`;
    this.tooltip_element.classList.add('on');
    this.move_tooltip();
  }

  move_tooltip() {
    const { canvas_x_in_pixels, canvas_y_in_pixels } = this.pointer;
    const tooltip_width_in_pixels = this.tooltip_element.offsetWidth || 120;
    const tooltip_left_in_pixels = canvas_x_in_pixels + 16 + tooltip_width_in_pixels > this.viewport_width_in_pixels ? canvas_x_in_pixels - tooltip_width_in_pixels - 12 : canvas_x_in_pixels + 16;
    this.tooltip_element.style.transform = `translate(${tooltip_left_in_pixels}px, ${canvas_y_in_pixels + 18}px)`;
  }

  hide_tooltip() {
    this.tooltip_element.classList.remove('on');
  }

  handle_click(pointer_event) {
    const [canvas_x_in_pixels, canvas_y_in_pixels] = this.canvas_position_of(pointer_event);
    const clicked_cube_region = this.find_view_cube_region_at(canvas_x_in_pixels, canvas_y_in_pixels);
    if (clicked_cube_region && clicked_cube_region !== 'background') this.fly_to_fitted_view(avoid_exactly_vertical_direction(vector_from_array(clicked_cube_region.userData.direction).normalize()));
    if (clicked_cube_region || !this.options.is_interactive) return;
    const picked_id = this.pick_entity_id_at(canvas_x_in_pixels, canvas_y_in_pixels);
    if (this.state.tool === 'measure') return this.add_measure_pick(picked_id);
    if (!picked_id && !pointer_event.shiftKey) this.clear_selection();
    if (!picked_id) return;
    if (pointer_event.shiftKey || pointer_event.metaKey || pointer_event.ctrlKey) return this.select(this.selection.includes(picked_id) ? this.selection.filter((entity_id) => entity_id !== picked_id) : [...this.selection, picked_id]);
    this.select(this.selection.length === 1 && this.selection[0] === picked_id ? [] : [picked_id]);
  }

  handle_double_click(pointer_event) {
    const [canvas_x_in_pixels, canvas_y_in_pixels] = this.canvas_position_of(pointer_event);
    if (this.find_view_cube_region_at(canvas_x_in_pixels, canvas_y_in_pixels)) return;
    const picked_id = this.pick_entity_id_at(canvas_x_in_pixels, canvas_y_in_pixels);
    if (!picked_id) return this.fit();
    const picked_entity = this.get_entity(picked_id);
    if (pointer_event.altKey && picked_entity?.kind === 'face') return this.look_at_face(picked_id);
    const pivot_point = this.ray_hit_point_on_face(canvas_x_in_pixels, canvas_y_in_pixels, picked_entity) || this.entity_anchor_point(picked_entity);
    if (!pivot_point) return;
    const camera = this.camera;
    const orbit_distance = camera.position.distanceTo(camera.isPerspectiveCamera ? pivot_point : this.controls.target);
    this.fly_to(pivot_point, this.camera_offset_from_target().normalize(), orbit_distance, this.orthographic_camera.zoom, true);
  }

  ray_hit_point_on_face(canvas_x_in_pixels, canvas_y_in_pixels, entity) {
    if (entity?.kind !== 'face') return null;
    const part = this.parts[entity.part_index];
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2((canvas_x_in_pixels / this.viewport_width_in_pixels) * 2 - 1, -(canvas_y_in_pixels / this.viewport_height_in_pixels) * 2 + 1), this.camera);
    const ray_in_part_space = raycaster.ray.clone();
    ray_in_part_space.origin.sub(part.explode_offset);
    return find_nearest_triangle_hit(ray_in_part_space, part.geometry, entity.start, Math.min(entity.count, 200000))?.add(part.explode_offset) || null;
  }

  entity_anchor_point(entity) {
    if (!entity) return null;
    const part = this.parts[entity.part_index];
    const anchor_point = entity.kind === 'part' ? part.bounding_box.getCenter(new THREE.Vector3()) : entity_center_point(entity);
    return anchor_point ? anchor_point.add(part.explode_offset) : null;
  }

  get_entity(entity_id) {
    if (!entity_id || !this.parts.length) return null;
    const [part_id, sub_entity_key] = String(entity_id).trim().split('/');
    const part = this.parts.find((candidate_part) => candidate_part.id === part_id);
    if (!part) return null;
    if (!sub_entity_key) return describe_part_entity(part);
    const is_face = sub_entity_key[0] === 'f';
    const scene_entity = (is_face ? part.face_by_id : part.edge_by_id).get(entity_id);
    if (!scene_entity) return null;
    const { points, ...entity_fields } = scene_entity;
    return { kind: is_face ? 'face' : 'edge', part_index: part.index, part_name: part.name, ...entity_fields };
  }

  select(entity_ids) {
    this.selection = [...new Set(parse_entity_ids(entity_ids).filter((entity_id) => this.get_entity(entity_id)))];
    this.refresh_overlays();
    this.emit_selection_change();
  }

  emit_selection_change() {
    this.dispatchEvent(new CustomEvent('selectionchange', { detail: { ids: this.selection.slice() } }));
  }

  clear_selection() {
    if (!this.selection.length && !this.measure_picks.length) return;
    this.reset_measurement();
    this.select([]);
  }

  highlight(entity_ids) {
    this.highlighted_ids = parse_entity_ids(entity_ids).filter((entity_id) => this.get_entity(entity_id));
    this.refresh_overlays();
  }

  refresh_overlays() {
    for (const part of this.parts) this.dispose_overlays(part);
    for (const entity_id of this.highlighted_ids) this.add_entity_overlay(entity_id, 'agent');
    for (const entity_id of this.selection) this.add_entity_overlay(entity_id, 'select');
    if (this.hovered_id && !this.selection.includes(this.hovered_id)) this.add_entity_overlay(this.hovered_id, 'hover');
    this.needs_render = true;
  }

  add_entity_overlay(entity_id, overlay_style) {
    const entity = this.get_entity(entity_id);
    if (!entity) return;
    const part = this.parts[entity.part_index];
    if (entity.kind !== 'edge') return part.overlays.add(this.create_surface_overlay(part, entity, overlay_style));
    const [first_segment_index, segment_count] = part.segment_range_by_edge_id.get(entity_id) || [0, 0];
    if (!segment_count) return;
    const overlay_geometry = new LineSegmentsGeometry();
    overlay_geometry.setPositions(part.segment_positions.subarray(first_segment_index * 6, (first_segment_index + segment_count) * 6));
    const overlay_lines = new LineSegments2(overlay_geometry, this.overlay_line_materials[overlay_style]);
    overlay_lines.renderOrder = 4;
    part.overlays.add(overlay_lines);
  }

  create_surface_overlay(part, entity, overlay_style) {
    const overlay_mesh = new THREE.Mesh(part.geometry, this.overlay_surface_materials[overlay_style]);
    if (entity.kind === 'face') overlay_mesh.onBeforeRender = (renderer, scene, camera, geometry) => geometry.setDrawRange(entity.start * 3, entity.count * 3);
    overlay_mesh.onAfterRender = (renderer, scene, camera, geometry) => geometry.setDrawRange(0, Infinity);
    overlay_mesh.renderOrder = 3;
    overlay_mesh.frustumCulled = false;
    return overlay_mesh;
  }

  look_at_face(face_id) {
    const face = this.get_entity(face_id);
    if (face?.kind !== 'face' || !(face.normal || face.axis)) return;
    const { distance, zoom } = this.compute_fit_for_box(this.visible_box());
    this.fly_to(this.entity_anchor_point(face) || this.model_center, avoid_exactly_vertical_direction(vector_from_array(face.normal || face.axis)).normalize(), distance, zoom, true);
  }

  set_part_visibility_flag(part, is_visible) {
    part.visible = is_visible;
    part.group.visible = is_visible;
  }

  set_part_visible(part_id, is_visible) {
    const part = this.parts.find((candidate_part) => candidate_part.id === part_id);
    if (!part) return;
    this.set_part_visibility_flag(part, is_visible);
    this.after_visibility_change();
  }

  set_visibility_of_all_parts(should_part_be_visible) {
    this.parts.forEach((part) => this.set_part_visibility_flag(part, should_part_be_visible(part)));
    this.after_visibility_change();
  }

  after_visibility_change() {
    this.shadow_needs_render = true;
    if (this.state.show_bounding_box) this.draw_bounding_box();
    this.needs_render = true;
    this.dispatchEvent(new CustomEvent('partschange'));
  }

  describe_model_statistics() {
    const sum_over_parts = (read_part_quantity) => this.parts.reduce((total, part) => total + read_part_quantity(part), 0);
    return {
      part_count: this.parts.length, face_count: sum_over_parts((part) => part.faces.length), edge_count: sum_over_parts((part) => part.edges.length), triangle_count: this.triangle_count || 0,
      area_in_square_millimeters: sum_over_parts((part) => part.area_in_square_millimeters), volume_in_cubic_millimeters: sum_over_parts((part) => part.volume_in_cubic_millimeters),
      bounding_box: describe_box(this.model_box || new THREE.Box3()),
    };
  }

  set_render_mode(render_mode, should_force = false) {
    if (render_mode === this.state.render_mode && !should_force) return;
    this.state.render_mode = render_mode;
    for (const part of this.parts) apply_render_mode_to_part(part, render_mode, this.depth_only_material);
    this.shadow_plane.visible = this.state.show_shadow && render_mode !== 'wireframe' && render_mode !== 'hidden';
    this.emit_state_change();
  }

  set_auto_rotate(should_rotate) {
    this.controls.autoRotate = should_rotate;
    this.controls.autoRotateSpeed = auto_rotate_speed;
  }

  set_grid_visible(is_visible) {
    this.state.show_grid = is_visible;
    this.grid.visible = is_visible;
    this.emit_state_change();
  }

  set_shadow_visible(is_visible) {
    this.state.show_shadow = is_visible;
    this.shadow_plane.visible = is_visible;
    this.shadow_needs_render = true;
    this.emit_state_change();
  }

  toggle_measure_tool() {
    this.set_tool(this.state.tool === 'measure' ? 'select' : 'measure');
  }

  set_tool(tool_name) {
    if (tool_name === this.state.tool) return;
    this.state.tool = tool_name;
    if (tool_name === 'measure') this.begin_measuring();
    else this.reset_measurement();
    this.container_element.classList.toggle('vc-measuring', tool_name === 'measure');
    this.emit_state_change();
  }

  begin_measuring() {
    this.measure_picks = this.selection.slice(-2);
    if (this.measure_picks.length === 2) this.run_measure();
    this.flash('Measure — pick two faces or edges');
  }

  async set_ambient_occlusion(should_enable) {
    this.state.ambient_occlusion_enabled = !!should_enable;
    if (should_enable && !this.composer) {
      await this.create_ambient_occlusion_composer().catch((composer_error) => {
        console.warn('AO unavailable', composer_error);
        this.state.ambient_occlusion_enabled = false;
      });
    }
    if (this.ambient_occlusion_pass && this.model_diagonal) this.ambient_occlusion_pass.updateGtaoMaterial({ radius: this.model_diagonal * 0.04, thickness: this.model_diagonal * 0.02 });
    this.emit_state_change();
  }

  async create_ambient_occlusion_composer() {
    const pass_modules = await Promise.all(['EffectComposer', 'RenderPass', 'GTAOPass', 'OutputPass'].map((module_name) => import(`three/addons/postprocessing/${module_name}.js`)));
    const [{ EffectComposer }, { RenderPass }, { GTAOPass }, { OutputPass }] = pass_modules;
    const viewport_width_in_pixels = this.viewport_width_in_pixels, viewport_height_in_pixels = this.viewport_height_in_pixels;
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(viewport_width_in_pixels, viewport_height_in_pixels, { type: THREE.HalfFloatType, samples: 4 }));
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(viewport_width_in_pixels, viewport_height_in_pixels);
    this.render_pass = new RenderPass(this.scene, this.camera);
    const ambient_occlusion_pass = this.ambient_occlusion_pass = new GTAOPass(this.scene, this.camera, viewport_width_in_pixels, viewport_height_in_pixels);
    ambient_occlusion_pass.output = GTAOPass.OUTPUT.Default;
    ambient_occlusion_pass.blendIntensity = 0.85;
    const model_diagonal = this.model_diagonal || 100;
    ambient_occlusion_pass.updateGtaoMaterial({ radius: model_diagonal * 0.04, distanceExponent: 1.5, thickness: model_diagonal * 0.02, scale: 1.0, samples: 12 });
    ambient_occlusion_pass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    ambient_occlusion_pass.overrideVisibility = () => this.hide_objects_excluded_from_ambient_occlusion(ambient_occlusion_pass._visibilityCache);
    [this.render_pass, ambient_occlusion_pass, new OutputPass()].forEach((render_pass) => this.composer.addPass(render_pass));
  }

  hide_objects_excluded_from_ambient_occlusion(visibility_cache) {
    this.scene.traverse((scene_object) => {
      visibility_cache.set(scene_object, scene_object.visible);
      const is_excluded = scene_object.isPoints || scene_object.isLine || scene_object.isLineSegments2 || scene_object.userData.excluded_from_ambient_occlusion || scene_object.userData.is_helper || scene_object === this.ghost_root || scene_object === this.helpers;
      if (is_excluded) scene_object.visible = false;
    });
  }

  is_camera_on_negative_side_of(direction) {
    return this.camera_offset_from_target().dot(direction) < 0;
  }

  set_section(section_changes = {}) {
    const section = this.state.section;
    const was_enabled = section.is_enabled;
    Object.assign(section, section_changes);
    const is_newly_enabled_with_default_orientation = section.is_enabled && !was_enabled && !section_changes.axis && !section_changes.face && section.axis !== 'custom' && section_changes.is_flipped == null;
    if (is_newly_enabled_with_default_orientation) section.is_flipped = this.is_camera_on_negative_side_of(vector_from_array(section.normal));
    if (section_changes.axis) section.normal = axis_normals[section_changes.axis];
    if (section_changes.axis && section_changes.is_flipped == null) section.is_flipped = this.is_camera_on_negative_side_of(vector_from_array(section.normal));
    if (section_changes.normal && !section_changes.axis) section.axis = 'custom';
    if (section_changes.face) this.orient_section_to_face(section_changes.face);
    this.apply_section();
    this.emit_state_change();
  }

  orient_section_to_face(face_id) {
    const section = this.state.section;
    delete section.face;
    const face = this.get_entity(face_id);
    if (!face?.normal) return;
    const face_normal = vector_from_array(face.normal).normalize();
    const [lowest_offset, highest_offset] = this.clip_range_along(face_normal);
    const face_point = this.entity_anchor_point(face) || this.model_center;
    const offset_fraction = THREE.MathUtils.clamp((face_normal.dot(face_point) - lowest_offset) / (highest_offset - lowest_offset || 1) - 0.002, 0, 1);
    Object.assign(section, { normal: face.normal.slice(), axis: 'custom', is_enabled: true, offset_fraction, is_flipped: this.is_camera_on_negative_side_of(face_normal) });
  }

  clip_range_along(section_normal) {
    const projected_offsets = box_corners(this.visible_box()).map((corner) => section_normal.dot(corner));
    const lowest_offset = Math.min(...projected_offsets), highest_offset = Math.max(...projected_offsets);
    const padding = (highest_offset - lowest_offset) * 0.01;
    return [lowest_offset - padding, highest_offset + padding];
  }

  apply_section() {
    const section = this.state.section;
    const is_cutting = section.is_enabled && this.parts.length > 0;
    this.clip_planes.length = 0;
    if (is_cutting) this.position_clip_plane(section);
    this.section_helper.visible = is_cutting;
    for (const part of this.parts) {
      part.cap.visible = is_cutting && part.mesh.visible && this.state.render_mode !== 'xray';
      [part.solid_material, part.xray_material, part.cap_material].forEach((material) => { material.needsUpdate = true; });
    }
    const shared_materials = [...this.line_materials, this.pick_material, this.depth_only_material, ...this.shadow_layers.map((shadow_layer) => shadow_layer.depth_material), ...Object.values(this.overlay_surface_materials)];
    shared_materials.forEach((material) => { material.needsUpdate = true; });
    this.shadow_needs_render = true;
    this.needs_render = true;
  }

  position_clip_plane(section) {
    const section_normal = vector_from_array(section.normal).normalize();
    const [lowest_offset, highest_offset] = this.clip_range_along(section_normal);
    const plane_offset = lowest_offset + (highest_offset - lowest_offset) * section.offset_fraction;
    this.clip_plane.set(section_normal.clone().multiplyScalar(section.is_flipped ? 1 : -1), section.is_flipped ? -plane_offset : plane_offset);
    this.clip_planes.push(this.clip_plane);
    this.section_offset_in_millimeters = plane_offset;
    const visible_box = this.visible_box(), visible_center = visible_box.getCenter(new THREE.Vector3());
    const helper_size = visible_box.getSize(new THREE.Vector3()).length() * 0.62;
    this.section_helper.position.copy(visible_center).addScaledVector(section_normal, plane_offset - section_normal.dot(visible_center));
    this.section_helper.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), section_normal);
    this.section_helper.scale.set(helper_size, helper_size, 1);
  }

  compute_explode_directions() {
    for (const part of this.parts) {
      const explode_direction = part.bounding_box.getCenter(new THREE.Vector3()).sub(this.model_center);
      const angle_around_model_in_radians = (part.index / Math.max(this.parts.length, 1)) * Math.PI * 2;
      if (explode_direction.length() < this.model_diagonal * 0.02) explode_direction.set(Math.cos(angle_around_model_in_radians), Math.sin(angle_around_model_in_radians), 0.3).multiplyScalar(this.model_diagonal * 0.15);
      part.explode_direction = explode_direction;
    }
  }

  set_explode(explode_fraction) {
    this.state.explode_fraction = THREE.MathUtils.clamp(+explode_fraction || 0, 0, 1);
    this.apply_explode();
    this.emit_state_change();
  }

  animate_explode(target_fraction) {
    this.explode_animation = { start_time_in_milliseconds: performance.now(), start_fraction: this.state.explode_fraction, target_fraction };
  }

  step_explode_animation(now_in_milliseconds) {
    const { start_time_in_milliseconds, start_fraction, target_fraction } = this.explode_animation;
    const progress_fraction = Math.min((now_in_milliseconds - start_time_in_milliseconds) / explode_animation_duration_in_milliseconds, 1);
    this.state.explode_fraction = start_fraction + (target_fraction - start_fraction) * ease_in_out_cubic(progress_fraction);
    this.apply_explode();
    if (progress_fraction >= 1) this.explode_animation = null;
    this.emit_state_change();
  }

  apply_explode() {
    const explode_scale = this.state.explode_fraction * 1.1;
    for (const part of this.parts) {
      part.explode_offset.copy(part.explode_direction).multiplyScalar(explode_scale);
      part.group.position.copy(part.explode_offset);
    }
    if (this.parts.length) this.layout_ground();
    if (this.state.section.is_enabled) this.apply_section();
    if (this.state.show_bounding_box) this.draw_bounding_box();
    if (this.measurement) this.draw_measurement();
    this.shadow_needs_render = true;
    this.needs_render = true;
  }

  set_ghost(ghost_scene) {
    for (const ghost_object of this.ghost_root.children.slice()) {
      ghost_object.geometry?.dispose();
      this.ghost_root.remove(ghost_object);
    }
    this.needs_render = true;
    if (!ghost_scene?.parts) return;
    this.ghost_surface_material ||= new THREE.MeshBasicMaterial({ color: 0xefe6e1, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide, clippingPlanes: this.clip_planes });
    this.ghost_edge_material ||= new THREE.LineBasicMaterial({ color: 0xefe6e1, transparent: true, opacity: 0.28, depthWrite: false });
    for (const scene_part of ghost_scene.parts) this.add_ghost_part(scene_part);
  }

  add_ghost_part(scene_part) {
    const surface_geometry = new THREE.BufferGeometry();
    surface_geometry.setAttribute('position', new THREE.BufferAttribute(decode_float32_array(scene_part.positions), 3));
    surface_geometry.setIndex(new THREE.BufferAttribute(decode_uint32_array(scene_part.indices), 1));
    const ghost_objects = [new THREE.Mesh(surface_geometry, this.ghost_surface_material)];
    const edge_coordinates = (scene_part.edges || []).flatMap((edge) => flatten_polyline_into_segments(edge.points ? decode_float32_array(edge.points) : null));
    if (edge_coordinates.length) {
      const edge_geometry = new THREE.BufferGeometry();
      edge_geometry.setAttribute('position', new THREE.Float32BufferAttribute(edge_coordinates, 3));
      ghost_objects.push(new THREE.LineSegments(edge_geometry, this.ghost_edge_material));
    }
    for (const ghost_object of ghost_objects) {
      ghost_object.renderOrder = 5;
      this.ghost_root.add(ghost_object);
    }
  }

  measurement_geometry(entity_id) {
    const entity = this.get_entity(entity_id);
    if (!entity) return null;
    const part = this.parts[entity.part_index];
    const explode_offset = part.explode_offset;
    if (entity.kind === 'part') return { entity, explode_offset, point: part.bounding_box.getCenter(new THREE.Vector3()) };
    const optional_vector = (coordinates) => (coordinates ? vector_from_array(coordinates) : null);
    if (entity.kind === 'face') return { entity, explode_offset, point: optional_vector(entity.center), normal: optional_vector(entity.normal)?.normalize() || null, axis: optional_vector(entity.axis)?.normalize() || null };
    const start_point = optional_vector(entity.start), end_point = optional_vector(entity.end);
    const point = entity.center ? vector_from_array(entity.center) : (start_point && end_point ? start_point.clone().lerp(end_point, 0.5) : start_point);
    return { entity, explode_offset, point, start_point, end_point, direction: entity.type === 'line' && start_point && end_point ? end_point.clone().sub(start_point).normalize() : null };
  }

  run_measure() {
    const [first_id, second_id] = this.measure_picks;
    const first_geometry = this.measurement_geometry(first_id), second_geometry = this.measurement_geometry(second_id);
    if (!first_geometry?.point || !second_geometry?.point) return;
    const { first_point, second_point, distance_in_millimeters, angle_in_degrees, kind } = measure_between_geometries(first_geometry, second_geometry);
    const delta = second_point.clone().sub(first_point).toArray().map(Math.abs);
    this.measurement = { first_id, second_id, distance_in_millimeters, angle_in_degrees, kind, delta, first_point: first_point.toArray(), second_point: second_point.toArray(), source: 'viewer' };
    this.measured_explode_offsets = [first_geometry.explode_offset, second_geometry.explode_offset];
    this.draw_measurement();
    this.emit_measure_event(this.measure_picks.slice(), this.measurement);
    if (this.options.measure_with_kernel && this.version_id) this.refine_measurement_with_kernel(this.measurement, this.measure_picks.slice());
  }

  async refine_measurement_with_kernel(measurement, measure_picks) {
    const kernel_measurement = await Promise.resolve(this.options.measure_with_kernel(measure_picks[0], measure_picks[1], this.version_id)).catch(() => null);
    if (!kernel_measurement || this.measure_picks.join() !== measure_picks.join() || kernel_measurement.distance == null) return;
    const kernel_kind = kernel_measurement.parallel ? 'minimum · parallel' : kernel_measurement.perpendicular ? 'minimum · perpendicular' : 'minimum (exact)';
    Object.assign(measurement, { distance_in_millimeters: kernel_measurement.distance, angle_in_degrees: kernel_measurement.angle_deg ?? measurement.angle_in_degrees, source: 'kernel', kind: kernel_kind, center_distance: kernel_measurement.center_distance });
    const closest_points = kernel_measurement.closest_points || kernel_measurement.points;
    if (closest_points?.length === 2) Object.assign(measurement, { first_point: closest_points[0], second_point: closest_points[1], delta: closest_points[0].map((coordinate, axis_index) => Math.abs(closest_points[1][axis_index] - coordinate)) });
    this.draw_measurement();
    this.emit_measure_event(measure_picks, measurement);
  }

  add_measure_pick(picked_id) {
    if (!picked_id) return;
    if (this.measure_picks.length >= 2) this.measure_picks = [];
    this.measure_picks.push(picked_id);
    this.select(this.measure_picks.slice());
    if (this.measure_picks.length === 2) return this.run_measure();
    this.measurement = null;
    this.draw_measurement();
    this.emit_measure_event(this.measure_picks.slice(), null);
  }

  emit_measure_event(measure_picks, measurement) {
    this.dispatchEvent(new CustomEvent('measure', { detail: { measure_picks, measurement } }));
  }

  reset_measurement() {
    this.measure_picks = [];
    this.measurement = null;
    this.draw_measurement();
  }

  clear_measure() {
    this.reset_measurement();
    this.select([]);
    this.emit_measure_event([], null);
  }

  remove_helper_group(group_name) {
    const previous_group = this.helpers.getObjectByName(group_name);
    previous_group?.traverse((scene_object) => scene_object.geometry?.dispose());
    if (previous_group) this.helpers.remove(previous_group);
    this.clear_screen_labels(group_name);
    this.needs_render = true;
  }

  draw_measurement() {
    this.remove_helper_group('measure');
    const measurement = this.measurement;
    if (!measurement) return;
    const [first_offset, second_offset] = this.measured_explode_offsets;
    const first_point = vector_from_array(measurement.first_point).add(first_offset), second_point = vector_from_array(measurement.second_point).add(second_offset);
    const measure_group = new THREE.Group();
    measure_group.name = 'measure';
    const line_geometry = new LineSegmentsGeometry();
    line_geometry.setPositions([...first_point.toArray(), ...second_point.toArray()]);
    const measure_line = new LineSegments2(line_geometry, this.overlay_line_materials.measure);
    measure_line.renderOrder = 10;
    measure_group.add(measure_line);
    const dot_geometry = new THREE.SphereGeometry(1, 16, 12);
    this.measure_dot_material ||= new THREE.MeshBasicMaterial({ color: dimension_color, depthTest: false, toneMapped: false });
    for (const end_point of [first_point, second_point]) {
      const end_dot = new THREE.Mesh(dot_geometry, this.measure_dot_material);
      end_dot.position.copy(end_point);
      end_dot.renderOrder = 11;
      end_dot.userData.screen_size_in_pixels = 4;
      measure_group.add(end_dot);
    }
    this.helpers.add(measure_group);
    const angle_html = measurement.angle_in_degrees != null && measurement.angle_in_degrees > 0.05 ? `<i>∠ ${format_number(measurement.angle_in_degrees, 1)}°</i>` : '';
    this.add_screen_label('measure', first_point.clone().lerp(second_point, 0.5), `<b>${format_number(measurement.distance_in_millimeters)}</b> mm${angle_html}`, 'vc-label vc-label-measure');
  }

  set_bounding_box(should_show) {
    this.state.show_bounding_box = !!should_show;
    this.draw_bounding_box();
    this.emit_state_change();
  }

  draw_bounding_box() {
    this.remove_helper_group('bbox');
    if (!this.state.show_bounding_box || !this.parts.length) return;
    const visible_box = this.visible_box();
    const visible_size = visible_box.getSize(new THREE.Vector3());
    const dash_length = visible_size.length() / 120;
    this.bounding_box_material ||= new THREE.LineDashedMaterial({ color: dimension_color, dashSize: 1, gapSize: 1, transparent: true, opacity: 0.6 });
    Object.assign(this.bounding_box_material, { dashSize: dash_length, gapSize: dash_length * 0.8 });
    const box_lines = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(...visible_size.toArray())), this.bounding_box_material);
    box_lines.computeLineDistances();
    box_lines.position.copy(visible_box.getCenter(new THREE.Vector3()));
    const box_group = new THREE.Group();
    box_group.name = 'bbox';
    box_group.add(box_lines);
    this.helpers.add(box_group);
    const { min, max } = visible_box;
    const dimension_labels = [['X', [(min.x + max.x) / 2, min.y, min.z], visible_size.x], ['Y', [max.x, (min.y + max.y) / 2, min.z], visible_size.y], ['Z', [max.x, min.y, (min.z + max.z) / 2], visible_size.z]];
    for (const [axis_letter, label_position, axis_length] of dimension_labels) this.add_screen_label('bbox', vector_from_array(label_position), `<span>${axis_letter}</span>${format_number(axis_length)}`, 'vc-label vc-label-dim');
  }

  add_screen_label(label_group, world_position, label_html, class_name) {
    const label_element = create_element('div', class_name, label_html);
    this.label_layer.appendChild(label_element);
    this.screen_labels.push({ label_group, world_position: world_position.clone(), label_element });
  }

  clear_screen_labels(label_group) {
    this.screen_labels.filter((label) => label.label_group === label_group).forEach((label) => label.label_element.remove());
    this.screen_labels = this.screen_labels.filter((label) => label.label_group !== label_group);
  }

  update_screen_labels() {
    const projected_position = new THREE.Vector3();
    for (const label of this.screen_labels) {
      projected_position.copy(label.world_position).project(this.camera);
      label.label_element.style.display = projected_position.z > 1 || projected_position.z < -1 ? 'none' : '';
      label.label_element.style.transform = `translate(${(projected_position.x * 0.5 + 0.5) * this.viewport_width_in_pixels}px, ${(-projected_position.y * 0.5 + 0.5) * this.viewport_height_in_pixels}px) translate(-50%, -50%)`;
    }
    const measure_dots = (this.helpers.getObjectByName('measure')?.children || []).filter((measure_child) => measure_child.userData.screen_size_in_pixels);
    for (const measure_dot of measure_dots) measure_dot.scale.setScalar(this.world_units_per_pixel_at(measure_dot.position) * measure_dot.userData.screen_size_in_pixels);
  }

  world_units_per_pixel_at(world_position) {
    const camera = this.camera;
    if (camera.isOrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / this.viewport_height_in_pixels;
    return (2 * camera.position.distanceTo(world_position) * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / this.viewport_height_in_pixels;
  }

  flash(toast_text) {
    this.toast_element.textContent = toast_text;
    this.toast_element.classList.add('on');
    clearTimeout(this.toast_timer);
    this.toast_timer = setTimeout(() => this.toast_element.classList.remove('on'), toast_duration_in_milliseconds);
  }

  toggle_help(should_show = !this.help_element.classList.contains('on')) {
    this.help_element.classList.toggle('on', should_show);
  }

  async screenshot({ should_download = false, file_name = 'biscad.png' } = {}) {
    const original_pixel_ratio = this.renderer.getPixelRatio();
    this.set_render_pixel_ratio(Math.min(original_pixel_ratio * 2, 4));
    this.is_view_cube_hidden = true;
    this.shadow_needs_render = true;
    this.render();
    const image_data_url = this.renderer.domElement.toDataURL('image/png');
    this.is_view_cube_hidden = false;
    this.set_render_pixel_ratio(original_pixel_ratio);
    this.needs_render = true;
    if (should_download) Object.assign(document.createElement('a'), { href: image_data_url, download: file_name }).click();
    return image_data_url;
  }

  set_render_pixel_ratio(pixel_ratio) {
    this.renderer.setPixelRatio(pixel_ratio);
    this.renderer.setSize(this.viewport_width_in_pixels, this.viewport_height_in_pixels, false);
    this.composer?.setPixelRatio(pixel_ratio);
    this.composer?.setSize(this.viewport_width_in_pixels, this.viewport_height_in_pixels);
  }

  emit_state_change() {
    this.needs_render = true;
    this.dispatchEvent(new CustomEvent('statechange', { detail: this.state }));
  }
}

function layout_shadow_layer(shadow_layer, { visible_center, visible_size, visible_diagonal, ground_height, shadow_width }) {
  shadow_layer.plane.scale.set(-shadow_width, shadow_width, 1);
  shadow_layer.plane.position.set(visible_center.x, visible_center.y, ground_height + (shadow_layer.is_tight_contact_layer ? visible_diagonal * 0.0002 : 0));
  const shadow_reach = shadow_layer.is_tight_contact_layer ? visible_diagonal * shadow_layer.reach_fraction : Math.max(visible_size.z, visible_diagonal * 0.3) * shadow_layer.reach_fraction;
  const shadow_camera = Object.assign(shadow_layer.camera, { left: -shadow_width / 2, right: shadow_width / 2, top: shadow_width / 2, bottom: -shadow_width / 2, near: 0, far: Math.max(shadow_reach, 1e-3) });
  shadow_camera.up.set(0, 1, 0);
  shadow_camera.position.set(visible_center.x, visible_center.y, ground_height);
  shadow_camera.lookAt(visible_center.x, visible_center.y, ground_height + 1);
  shadow_camera.updateProjectionMatrix();
}

const angle_between_in_degrees = (first_direction, second_direction, lowest_cosine) => THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(Math.abs(first_direction.dot(second_direction)), lowest_cosine, 1)));

function measure_between_geometries(first, second) {
  const center_to_center = { first_point: first.point.clone(), second_point: second.point.clone(), distance_in_millimeters: first.point.distanceTo(second.point), angle_in_degrees: null, kind: 'center-to-center' };
  if (first.normal && second.normal) return measure_between_planes(first, second, center_to_center);
  if (first.direction && second.direction) return measure_between_lines(first, second);
  if ((first.normal && second.entity.kind === 'edge') || (second.normal && first.entity.kind === 'edge')) return measure_between_edge_and_plane(first, second, center_to_center);
  if (first.axis && second.axis && Math.abs(first.axis.dot(second.axis)) > 0.9999) return measure_between_parallel_axes(first, second, center_to_center);
  return center_to_center;
}

function measure_between_planes(first, second, center_to_center) {
  const angle_in_degrees = angle_between_in_degrees(first.normal, second.normal, -1);
  if (angle_in_degrees >= 0.05) return { ...center_to_center, angle_in_degrees };
  const signed_gap = second.point.clone().sub(first.point).dot(first.normal);
  return { ...center_to_center, second_point: center_to_center.first_point.clone().addScaledVector(first.normal, signed_gap), distance_in_millimeters: Math.abs(signed_gap), angle_in_degrees: 0, kind: 'parallel planes' };
}

function measure_between_lines(first, second) {
  const [first_point, second_point] = closest_points_between_segments(first.start_point, first.end_point, second.start_point, second.end_point);
  return { first_point, second_point, distance_in_millimeters: first_point.distanceTo(second_point), angle_in_degrees: angle_between_in_degrees(first.direction, second.direction, 0), kind: 'minimum' };
}

function measure_between_edge_and_plane(first, second, center_to_center) {
  const plane = first.normal ? first : second, edge = first.normal ? second : first;
  const signed_gap = edge.point.clone().sub(plane.point).dot(plane.normal);
  const angle_in_degrees = edge.direction ? 90 - angle_between_in_degrees(edge.direction, plane.normal, 0) : null;
  if (edge.direction && Math.abs(edge.direction.dot(plane.normal)) >= 1e-3) return { ...center_to_center, angle_in_degrees };
  const point_on_edge = edge.point.clone(), point_on_plane = point_on_edge.clone().addScaledVector(plane.normal, -signed_gap);
  const [first_point, second_point] = plane === first ? [point_on_plane, point_on_edge] : [point_on_edge, point_on_plane];
  return { first_point, second_point, distance_in_millimeters: Math.abs(signed_gap), angle_in_degrees, kind: 'to plane' };
}

function measure_between_parallel_axes(first, second, center_to_center) {
  const center_offset = second.point.clone().sub(first.point);
  const perpendicular_offset = center_offset.clone().addScaledVector(first.axis, -center_offset.dot(first.axis));
  return { ...center_to_center, second_point: center_to_center.first_point.clone().add(perpendicular_offset), distance_in_millimeters: perpendicular_offset.length(), kind: 'axis to axis' };
}

function closest_points_between_segments(first_start, first_end, second_start, second_end) {
  const first_direction = first_end.clone().sub(first_start), second_direction = second_end.clone().sub(second_start);
  const [first_parameter, second_parameter] = closest_segment_parameters(first_direction, second_direction, first_start.clone().sub(second_start));
  return [first_start.clone().addScaledVector(first_direction, first_parameter), second_start.clone().addScaledVector(second_direction, second_parameter)];
}

function closest_segment_parameters(first_direction, second_direction, start_offset) {
  const clamp_to_unit = (parameter) => THREE.MathUtils.clamp(parameter, 0, 1);
  const first_length_squared = first_direction.dot(first_direction), second_length_squared = second_direction.dot(second_direction);
  const second_offset_projection = second_direction.dot(start_offset), first_offset_projection = first_direction.dot(start_offset);
  if (first_length_squared <= 1e-9 && second_length_squared <= 1e-9) return [0, 0];
  if (first_length_squared <= 1e-9) return [0, clamp_to_unit(second_offset_projection / second_length_squared)];
  if (second_length_squared <= 1e-9) return [clamp_to_unit(-first_offset_projection / first_length_squared), 0];
  const directions_dot = first_direction.dot(second_direction), denominator = first_length_squared * second_length_squared - directions_dot * directions_dot;
  const first_parameter = denominator !== 0 ? clamp_to_unit((directions_dot * second_offset_projection - first_offset_projection * second_length_squared) / denominator) : 0;
  const second_parameter = (directions_dot * first_parameter + second_offset_projection) / second_length_squared;
  if (second_parameter < 0) return [clamp_to_unit(-first_offset_projection / first_length_squared), 0];
  if (second_parameter > 1) return [clamp_to_unit((directions_dot - first_offset_projection) / first_length_squared), 1];
  return [first_parameter, second_parameter];
}

const draw_icon = (path_markup) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" >${path_markup}</svg>`;
const icons = {
  select: draw_icon('<path d="M5 3.5l13 7.2-5.6 1.6 3.4 6.3-2.2 1.2-3.4-6.3L6 17.4z"/>'),
  measure: draw_icon('<path d="M3.5 15.5l12-12 5 5-12 12z"/><path d="M7 12l2 2M10 9l1.5 1.5M13 6l2 2"/>'),
  section: draw_icon('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M3 12.5l18-3" stroke-dasharray="2 2"/><path d="M4 12.3v4.2L12 21l8-4.5V9.3z" fill="currentColor" fill-opacity=".12" stroke="none"/>'),
  explode: draw_icon('<rect x="9" y="9" width="6" height="6"/><path d="M4 4l3 3M20 4l-3 3M4 20l3-3M20 20l-3-3"/><path d="M4 7.5V4h3.5M20 7.5V4h-3.5M4 16.5V20h3.5M20 16.5V20h-3.5"/>'),
  cube: draw_icon('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  fit: draw_icon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="8.5" y="8.5" width="7" height="7"/>'),
  perspective: draw_icon('<path d="M3 7l18-3v16L3 17z"/><path d="M3 12h18" stroke-dasharray="2 2"/>'),
  orthographic: draw_icon('<rect x="4" y="5" width="16" height="14"/><path d="M4 12h16" stroke-dasharray="2 2"/>'),
  'shade_shaded-edges': draw_icon('<circle cx="12" cy="12" r="8" fill="currentColor" fill-opacity=".35"/><path d="M4 12h16M12 4c-2.5 2.2-2.5 13.8 0 16"/>'),
  shade_shaded: draw_icon('<circle cx="12" cy="12" r="8" fill="currentColor" fill-opacity=".85"/>'),
  shade_hidden: draw_icon('<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c-2.5 2.2-2.5 13.8 0 16" stroke-dasharray="1.6 2"/>'),
  shade_wireframe: draw_icon('<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c-3 2.5-3 13.5 0 16M12 4c3 2.5 3 13.5 0 16M6 7h12M6 17h12"/>'),
  shade_xray: draw_icon('<circle cx="12" cy="12" r="8" fill="currentColor" fill-opacity=".15"/><path d="M12 4a8 8 0 010 16" fill="currentColor" fill-opacity=".35" stroke="none"/><circle cx="12" cy="12" r="3.5" stroke-dasharray="1.6 1.6"/>'),
  overlays: draw_icon('<circle cx="9" cy="10" r="5.5"/><circle cx="15" cy="14" r="5.5"/>'),
  bbox: draw_icon('<rect x="4" y="4" width="16" height="16" stroke-dasharray="2.5 2"/><path d="M4 22h16M2 4v16"/>'),
  camera: draw_icon('<path d="M3.5 8h4l1.5-2.5h6L16.5 8h4v11h-17z"/><circle cx="12" cy="13" r="3.5"/>'),
  help: draw_icon('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 014.8.9c0 1.7-2.4 2.1-2.4 3.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  eye: draw_icon('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>'),
  eye_off: draw_icon('<path d="M4 4l16 16"/><path d="M9.9 6A9.6 9.6 0 0112 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 01-2.8 3.5M6.3 7.6C3.9 9.4 2.5 12 2.5 12S6 18.5 12 18.5c1.5 0 2.8-.4 4-1"/>'),
  target: draw_icon('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
  copy: draw_icon('<rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/>'),
  flip: draw_icon('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M8 7L3 12l5 5zM16 7l5 5-5 5z"/>'),
  play: draw_icon('<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>'),
  step_previous: draw_icon('<path d="M15 6l-6 6 6 6"/>'),
  step_next: draw_icon('<path d="M9 6l6 6-6 6"/>'),
  pause: draw_icon('<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" stroke="none"/>'),
  operation_sketch: draw_icon('<path d="M4 20l4-1 11-11-3-3L5 16z"/><path d="M14 7l3 3"/>'),
  operation_extrude: draw_icon('<path d="M5 15l7 4 7-4-7-4z"/><path d="M5 15V8l7-4 7 4v7" stroke-dasharray="2 2"/><path d="M12 11V4"/><path d="M10 6l2-2 2 2"/>'),
  operation_revolve: draw_icon('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M17 7a6 3 0 11-10 0"/><path d="M7 7l-1.5 2.5M7 7l2.5 1"/>'),
  operation_fillet: draw_icon('<path d="M4 20V10a6 6 0 016-6h10"/><path d="M4 4h4M4 4v4" stroke-opacity=".4"/>'),
  operation_chamfer: draw_icon('<path d="M4 20V10l6-6h10"/><path d="M4 4h4M4 4v4" stroke-opacity=".4"/>'),
  operation_hole: draw_icon('<ellipse cx="12" cy="7" rx="6" ry="2.5"/><path d="M6 7v10c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7"/><path d="M9 8.6v8" stroke-dasharray="1.5 2"/>'),
  operation_boolean: draw_icon('<circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>'),
  operation_cut: draw_icon('<rect x="3.5" y="6" width="17" height="12"/><circle cx="12" cy="12" r="3" fill="currentColor" fill-opacity=".25"/>'),
  operation_shell: draw_icon('<path d="M4 7h16v13H4z"/><path d="M7 7v10h10V7"/>'),
  operation_pattern: draw_icon('<rect x="3" y="3" width="6" height="6"/><rect x="15" y="3" width="6" height="6"/><rect x="3" y="15" width="6" height="6"/><rect x="15" y="15" width="6" height="6"/>'),
  operation_mirror: draw_icon('<path d="M12 3v18" stroke-dasharray="2 2"/><path d="M9 7L4 17h5zM15 7l5 10h-5z"/>'),
  operation_loft: draw_icon('<path d="M6 18h12M8 6h8"/><path d="M6 18L8 6M18 18L16 6"/>'),
  operation_primitive: draw_icon('<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>'),
  operation_step: draw_icon('<circle cx="12" cy="12" r="3.5"/>'),
};

const operation_icon_patterns = [
  [/sketch|line|polyline|circle|rect|make_face|polygon|arc/, 'operation_sketch'],
  [/extrude|prism/, 'operation_extrude'], [/revolve/, 'operation_revolve'], [/fillet/, 'operation_fillet'], [/chamfer/, 'operation_chamfer'],
  [/hole|bore|counter/, 'operation_hole'], [/subtract|cut|split/, 'operation_cut'], [/union|add|fuse|boolean|intersect/, 'operation_boolean'],
  [/shell|offset/, 'operation_shell'], [/pattern|polar|grid|array|locations/, 'operation_pattern'], [/mirror/, 'operation_mirror'],
  [/loft|sweep/, 'operation_loft'], [/box|cylinder|sphere|cone|torus|primitive|wedge/, 'operation_primitive'],
];
const icon_for_operation = (operation_name = '') => icons[operation_icon_patterns.find(([operation_pattern]) => operation_pattern.test(String(operation_name).toLowerCase()))?.[1] || 'operation_step'];

const overlay_toggles = {
  grid: { label: 'Grid', is_on: (state) => state.show_grid, toggle: (viewer) => viewer.set_grid_visible(!viewer.state.show_grid) },
  shadow: { label: 'Ground shadow', is_on: (state) => state.show_shadow, toggle: (viewer) => viewer.set_shadow_visible(!viewer.state.show_shadow) },
  ao: { label: 'Ambient occlusion', is_on: (state) => state.ambient_occlusion_enabled, toggle: (viewer) => viewer.set_ambient_occlusion(!viewer.state.ambient_occlusion_enabled) },
};

const close_toolbar_popovers = (toolbar) => toolbar.popovers.forEach((popover_element) => popover_element.classList.remove('on'));
const set_range_unless_focused = (range_input, range_position) => { if (document.activeElement !== range_input) range_input.value = range_position; };

function create_toolbar_button(toolbar, button_key, icon_markup, tooltip_text, handle_click = () => {}) {
  const toolbar_button = create_element('button', 'vc-tb', icon_markup);
  Object.assign(toolbar_button.dataset, { tip: tooltip_text, key: button_key });
  toolbar_button.setAttribute('aria-label', tooltip_text);
  toolbar_button.addEventListener('click', handle_click);
  toolbar.buttons[button_key] = toolbar_button;
  return toolbar_button;
}

function wrap_with_popover(toolbar, toolbar_button, popover_element) {
  const popover_wrapper = create_element('div', 'vc-tbw');
  popover_element.classList.add('vc-pop');
  popover_wrapper.append(toolbar_button, popover_element);
  toolbar.popovers.push(popover_element);
  toolbar.popover_by_key[toolbar_button.dataset.key] = popover_element;
  toolbar_button.addEventListener('click', () => {
    const should_open = !popover_element.classList.contains('on');
    close_toolbar_popovers(toolbar);
    popover_element.classList.toggle('on', should_open);
  });
  return popover_wrapper;
}

function choose_section_axis(viewer, axis_choice) {
  if (axis_choice !== 'face') return viewer.set_section({ axis: axis_choice, is_enabled: true });
  const planar_face_id = viewer.selection.find((entity_id) => viewer.get_entity(entity_id)?.normal);
  if (!planar_face_id) return viewer.flash('Select a planar face first');
  viewer.set_section({ face: planar_face_id });
}

function build_section_tool(toolbar) {
  const viewer = toolbar.viewer;
  const section_popover = create_element('div', '', `
        <div class="vc-pop-h"><span>Section</span><label class="vc-switch"><input type="checkbox" data-k="on"><i></i></label></div>
        <div class="vc-seg" data-k="axis"><button data-v="x">X</button><button data-v="y">Y</button><button data-v="z">Z</button><button data-v="face" title="Use selected planar face">Face</button></div>
        <input type="range" min="0" max="1" step="0.001" data-k="offset">
        <div class="vc-pop-row"><span class="vc-mono" data-k="val">—</span><button class="vc-mini" data-k="flip">${icons.flip}<span>Flip</span></button></div>`);
  section_popover.querySelector('[data-k=on]').addEventListener('change', (change_event) => viewer.set_section({ is_enabled: change_event.target.checked }));
  section_popover.querySelectorAll('[data-k=axis] button').forEach((axis_button) => axis_button.addEventListener('click', () => choose_section_axis(viewer, axis_button.dataset.v)));
  section_popover.querySelector('[data-k=offset]').addEventListener('input', (input_event) => viewer.set_section({ offset_fraction: +input_event.target.value, is_enabled: true }));
  section_popover.querySelector('[data-k=flip]').addEventListener('click', () => viewer.set_section({ is_flipped: !viewer.state.section.is_flipped }));
  return wrap_with_popover(toolbar, create_toolbar_button(toolbar, 'section', icons.section, 'Section plane · S'), section_popover);
}

function build_explode_tool(toolbar) {
  const explode_popover = create_element('div', '', `<div class="vc-pop-h"><span>Explode</span><span class="vc-mono" data-k="val">0%</span></div><input type="range" min="0" max="1" step="0.005" data-k="t">`);
  explode_popover.querySelector('[data-k=t]').addEventListener('input', (input_event) => toolbar.viewer.set_explode(+input_event.target.value));
  return wrap_with_popover(toolbar, create_toolbar_button(toolbar, 'explode', icons.explode, 'Explode · X'), explode_popover);
}

function build_views_menu(toolbar) {
  const views_menu = create_element('div', 'vc-menu');
  view_names_in_shortcut_order.forEach((view_name, view_index) => {
    const view_item = create_element('button', 'vc-menu-it', `<span>${view_name[0].toUpperCase() + view_name.slice(1)}</span><kbd>${view_index + 1}</kbd>`);
    view_item.addEventListener('click', () => { toolbar.viewer.set_view(view_name); close_toolbar_popovers(toolbar); });
    views_menu.appendChild(view_item);
  });
  return wrap_with_popover(toolbar, create_toolbar_button(toolbar, 'views', icons.cube, 'Standard views · 1–7'), views_menu);
}

function build_shading_group(toolbar) {
  const shading_group = create_element('div', 'vc-shading');
  for (const [render_mode, render_mode_label] of render_modes_with_labels) {
    const shading_button = create_toolbar_button(toolbar, 'shade_' + render_mode, icons['shade_' + render_mode], render_mode_label + ' · W', () => toolbar.viewer.set_render_mode(render_mode));
    shading_button.dataset.mode = render_mode;
    shading_group.appendChild(shading_button);
  }
  return shading_group;
}

function build_overlays_menu(toolbar) {
  const overlays_menu = create_element('div', 'vc-menu', '<div class="vc-pop-h"><span>Overlays</span></div>');
  for (const [toggle_key, overlay_toggle] of Object.entries(overlay_toggles)) {
    const toggle_item = create_element('button', 'vc-menu-it vc-check', `<span>${overlay_toggle.label}</span><i></i>`);
    toggle_item.dataset.toggle = toggle_key;
    toggle_item.addEventListener('click', () => overlay_toggle.toggle(toolbar.viewer));
    overlays_menu.appendChild(toggle_item);
  }
  return wrap_with_popover(toolbar, create_toolbar_button(toolbar, 'overlays', icons.overlays, 'Viewport overlays'), overlays_menu);
}

const toolbar_item_builders = {
  '|': () => create_element('span', 'vc-tbsep'),
  select: (toolbar) => create_toolbar_button(toolbar, 'select', icons.select, 'Select · Esc', () => toolbar.viewer.set_tool('select')),
  measure: (toolbar) => create_toolbar_button(toolbar, 'measure', icons.measure, 'Measure · M', () => toolbar.viewer.toggle_measure_tool()),
  section: build_section_tool,
  explode: build_explode_tool,
  views: build_views_menu,
  fit: (toolbar) => create_toolbar_button(toolbar, 'fit', icons.fit, 'Frame all · F', () => toolbar.viewer.fit()),
  projection: (toolbar) => create_toolbar_button(toolbar, 'projection', icons.perspective, 'Perspective / orthographic · P', () => toolbar.viewer.toggle_projection()),
  shading: build_shading_group,
  overlays: build_overlays_menu,
  bbox: (toolbar) => create_toolbar_button(toolbar, 'bbox', icons.bbox, 'Bounding box · B', () => toolbar.viewer.set_bounding_box(!toolbar.viewer.state.show_bounding_box)),
  screenshot: (toolbar) => create_toolbar_button(toolbar, 'screenshot', icons.camera, 'Screenshot PNG', () => toolbar.viewer.screenshot({ should_download: true, file_name: (toolbar.viewer.loaded_scene?.name || 'biscad') + '.png' })),
  help: (toolbar) => create_toolbar_button(toolbar, 'help', icons.help, 'Shortcuts · ?', () => toolbar.viewer.toggle_help()),
};

function sync_section_popover(section_popover, viewer) {
  const section = viewer.state.section;
  section_popover.querySelector('[data-k=on]').checked = section.is_enabled;
  section_popover.querySelectorAll('[data-k=axis] button').forEach((axis_button) => axis_button.classList.toggle('on', section.axis === axis_button.dataset.v || (axis_button.dataset.v === 'face' && section.axis === 'custom')));
  set_range_unless_focused(section_popover.querySelector('[data-k=offset]'), section.offset_fraction);
  const axis_name = section.axis === 'custom' ? 'd' : section.axis.toUpperCase();
  section_popover.querySelector('[data-k=val]').textContent = section.is_enabled && viewer.section_offset_in_millimeters != null ? `${axis_name} = ${format_number(viewer.section_offset_in_millimeters)} mm` : 'off';
}

function sync_toolbar_with_state(toolbar, toolbar_element) {
  const { buttons, popover_by_key, viewer } = toolbar, state = viewer.state;
  buttons.select?.classList.toggle('on', state.tool === 'select');
  buttons.measure?.classList.toggle('on', state.tool === 'measure');
  buttons.bbox?.classList.toggle('on', state.show_bounding_box);
  buttons.section?.classList.toggle('on', state.section.is_enabled);
  buttons.explode?.classList.toggle('on', state.explode_fraction > 0.001);
  if (buttons.projection) buttons.projection.innerHTML = state.projection === 'perspective' ? icons.perspective : icons.orthographic;
  if (popover_by_key.section) sync_section_popover(popover_by_key.section, viewer);
  if (popover_by_key.explode) set_range_unless_focused(popover_by_key.explode.querySelector('[data-k=t]'), state.explode_fraction);
  if (popover_by_key.explode) popover_by_key.explode.querySelector('[data-k=val]').textContent = Math.round(state.explode_fraction * 100) + '%';
  toolbar_element.querySelectorAll('.vc-shading [data-mode]').forEach((shading_button) => shading_button.classList.toggle('on', shading_button.dataset.mode === state.render_mode));
  popover_by_key.overlays?.querySelectorAll('[data-toggle]').forEach((toggle_item) => toggle_item.classList.toggle('on', !!overlay_toggles[toggle_item.dataset.toggle].is_on(state)));
}

export function mount_toolbar(viewer, toolbar_element, item_keys = ['select', 'measure', 'section', 'explode', '|', 'views', 'fit', 'projection', '|', 'shading', 'overlays', 'bbox', 'screenshot', 'help']) {
  const toolbar = { viewer, buttons: {}, popovers: [], popover_by_key: {} };
  toolbar_element.classList.add('vc-toolbar');
  document.addEventListener('pointerdown', (pointer_event) => { if (!toolbar_element.contains(pointer_event.target)) close_toolbar_popovers(toolbar); });
  for (const item_key of item_keys) toolbar_element.appendChild(toolbar_item_builders[item_key](toolbar));
  const sync_toolbar = () => sync_toolbar_with_state(toolbar, toolbar_element);
  viewer.addEventListener('statechange', sync_toolbar);
  viewer.addEventListener('load', () => {
    if (toolbar.buttons.explode) toolbar.buttons.explode.parentElement.style.display = viewer.parts.length > 1 ? '' : 'none';
    sync_toolbar();
  });
  sync_toolbar();
}

export class PartTree {
  constructor(viewer, tree_element) {
    this.viewer = viewer;
    this.tree_element = tree_element;
    tree_element.classList.add('vc-tree');
    viewer.addEventListener('load', () => this.render());
    viewer.addEventListener('partschange', () => this.render());
    viewer.addEventListener('selectionchange', () => this.mark_selected_rows());
    this.render();
  }

  render() {
    this.tree_element.innerHTML = this.viewer.parts.length ? '' : '<div class="vc-empty">No parts</div>';
    for (const part of this.viewer.parts) this.tree_element.appendChild(this.create_row(part));
    this.mark_selected_rows();
  }

  create_row(part) {
    const viewer = this.viewer;
    const tree_row = create_element('div', 'vc-tree-row' + (part.visible ? '' : ' off'), `<span class="vc-sw" style="background:${part.color}"></span><span class="vc-tree-name" title="${part.name}">${part.name}</span><span class="vc-tree-id">${part.id}</span>
        <button class="vc-ib" data-a="iso" title="Isolate">${icons.target}</button><button class="vc-ib" data-a="vis" title="${part.visible ? 'Hide' : 'Show'}">${part.visible ? icons.eye : icons.eye_off}</button>`);
    tree_row.dataset.id = part.id;
    tree_row.addEventListener('click', (click_event) => {
      const row_action = click_event.target.closest('button')?.dataset.a;
      if (row_action === 'vis') return viewer.set_part_visible(part.id, !part.visible);
      if (row_action !== 'iso') return viewer.select(click_event.shiftKey ? [...viewer.selection, part.id] : [part.id]);
      const is_already_isolated = viewer.parts.every((candidate_part) => (candidate_part.id === part.id) === candidate_part.visible);
      viewer.set_visibility_of_all_parts(is_already_isolated ? () => true : (candidate_part) => candidate_part.id === part.id);
    });
    return tree_row;
  }

  mark_selected_rows() {
    const selected_part_ids = new Set(this.viewer.selection.map((entity_id) => entity_id.split('/')[0]));
    this.tree_element.querySelectorAll('.vc-tree-row').forEach((tree_row) => tree_row.classList.toggle('sel', selected_part_ids.has(tree_row.dataset.id)));
  }
}

export async function copy_text_to_clipboard(text_to_copy) {
  try { await navigator.clipboard.writeText(text_to_copy); } catch (clipboard_error) {
    const fallback_textarea = Object.assign(document.createElement('textarea'), { value: text_to_copy });
    document.body.appendChild(fallback_textarea);
    fallback_textarea.select();
    document.execCommand('copy');
    fallback_textarea.remove();
  }
}

const definition_rows_html = (label_text_pairs) => label_text_pairs.filter(([, row_text]) => row_text != null && row_text !== '—').map(([row_label, row_text]) => `<dt>${row_label}</dt><dd>${row_text}</dd>`).join('');
const format_millimeters = (length_in_millimeters) => (length_in_millimeters != null ? format_number(length_in_millimeters, 3) + ' mm' : null);

function describe_entity_properties(entity) {
  if (entity.kind === 'face') return [['Type', entity.type], ['Area', format_number(entity.area, 3) + ' mm²'], ['Radius', format_millimeters(entity.radius)], ['Diameter', entity.radius != null ? '⌀ ' + format_number(entity.radius * 2, 3) : null], ['Normal', entity.normal ? format_vector(entity.normal, 3) : null], ['Axis', entity.axis ? format_vector(entity.axis, 3) : null], ['Center', format_vector(entity.center)], ['Part', entity.part_name]];
  if (entity.kind === 'edge') return [['Type', entity.type], ['Length', format_number(entity.length, 3) + ' mm'], ['Radius', format_millimeters(entity.radius)], ['Center', entity.center ? format_vector(entity.center) : null], ['Start', format_vector(entity.start)], ['End', format_vector(entity.end)], ['Part', entity.part_name]];
  return [['Name', entity.name], ['Faces', entity.face_count], ['Edges', entity.edge_count], ['Triangles', entity.triangle_count.toLocaleString()], ['Size', format_vector(entity.bounding_box.size)], ['Area', format_number(entity.area_in_square_millimeters, 1) + ' mm²'], ['Volume', format_number(entity.volume_in_cubic_millimeters / 1000, 3) + ' cm³']];
}

function describe_measurement_html(measurement) {
  const measurement_rows = [['Kind', measurement.kind], ['Angle', measurement.angle_in_degrees != null ? format_number(measurement.angle_in_degrees, 2) + '°' : null], ['ΔX ΔY ΔZ', format_vector(measurement.delta)], ['Source', measurement.source === 'kernel' ? 'kernel (exact)' : 'viewer']];
  return `<div class="vc-measure"><div class="vc-measure-v">${format_number(measurement.distance_in_millimeters, 3)}<small>mm</small></div>
        <dl>${definition_rows_html(measurement_rows)}</dl></div>`;
}

function describe_multi_selection_html(selected_ids, selected_entities) {
  const faces = selected_entities.filter((entity) => entity?.kind === 'face'), edges = selected_entities.filter((entity) => entity?.kind === 'edge');
  const total_area = faces.reduce((area_sum, face) => area_sum + (face.area || 0), 0), total_length = edges.reduce((length_sum, edge) => length_sum + (edge.length || 0), 0);
  return `<div class="vc-ent"><div class="vc-ent-h"><span class="vc-ent-id">${selected_ids.length} selected</span></div><div class="vc-chips">${selected_ids.map((entity_id) => `<span>${entity_id}</span>`).join('')}</div>
        <dl>${definition_rows_html([['Faces', faces.length || null], ['Total area', faces.length ? format_number(total_area, 3) + ' mm²' : null], ['Edges', edges.length || null], ['Total length', edges.length ? format_number(total_length, 3) + ' mm' : null]])}</dl></div>`;
}

export class SelectionPanel {
  constructor(viewer, panel_element) {
    this.viewer = viewer;
    this.panel_element = panel_element;
    panel_element.classList.add('vc-sel');
    for (const event_name of ['selectionchange', 'measure', 'statechange']) viewer.addEventListener(event_name, () => this.render());
    this.render();
  }

  render() {
    const viewer = this.viewer, selected_ids = viewer.selection, is_measuring = viewer.state.tool === 'measure';
    if (!selected_ids.length) {
      this.panel_element.innerHTML = `<div class="vc-sel-empty">${is_measuring ? 'Pick two faces or edges to measure.' : 'Click a face or edge. <span>Shift</span> adds to the selection. The ids are what an agent sees.'}</div>`;
      return;
    }
    const selected_entities = selected_ids.map((entity_id) => viewer.get_entity(entity_id));
    const shows_each_entity = selected_ids.length === 1 || (selected_ids.length === 2 && is_measuring);
    const each_entity_html = () => selected_entities.map((entity, entity_position) => (entity ? `<div class="vc-ent"><div class="vc-ent-h"><span class="vc-ent-id">${selected_ids[entity_position]}</span><span class="vc-ent-k">${entity.kind}</span></div><dl>${definition_rows_html(describe_entity_properties(entity))}</dl></div>` : '')).join('');
    const single_face = selected_ids.length === 1 && selected_entities[0]?.kind === 'face' ? selected_entities[0] : null;
    this.panel_element.innerHTML = (viewer.measurement && is_measuring ? describe_measurement_html(viewer.measurement) : '') + (shows_each_entity ? each_entity_html() : describe_multi_selection_html(selected_ids, selected_entities)) + `<div class="vc-sel-actions">
      <button class="vc-btn vc-btn-dark" data-a="copy">${icons.copy}<span>Copy reference</span></button>
      ${single_face && (single_face.normal || single_face.axis) ? `<button class="vc-btn" data-a="look" title="Look normal to face">${icons.target}</button>` : ''}
      ${single_face?.normal ? `<button class="vc-btn" data-a="section" title="Section on this face">${icons.section}</button>` : ''}
    </div>`;
    this.panel_element.querySelector('[data-a=copy]').addEventListener('click', (click_event) => copy_reference_with_feedback(selected_ids.join(', '), click_event.currentTarget.querySelector('span')));
    this.panel_element.querySelector('[data-a=look]')?.addEventListener('click', () => viewer.look_at_face(selected_ids[0]));
    this.panel_element.querySelector('[data-a=section]')?.addEventListener('click', () => viewer.set_section({ face: selected_ids[0] }));
  }
}

async function copy_reference_with_feedback(reference_text, button_label) {
  await copy_text_to_clipboard(reference_text);
  button_label.textContent = 'Copied ' + reference_text.slice(0, 28) + (reference_text.length > 28 ? '…' : '');
  setTimeout(() => { button_label.textContent = 'Copy reference'; }, copy_feedback_duration_in_milliseconds);
}

export function paint_range_fill(range_input) {
  const range_minimum = +range_input.min || 0, range_maximum = +range_input.max || 1;
  range_input.style.setProperty('--fill', ((+range_input.value - range_minimum) / (range_maximum - range_minimum || 1)) * 100 + '%');
}
document.addEventListener('input', (input_event) => { if (input_event.target?.type === 'range') paint_range_fill(input_event.target); }, true);

export class StepsBar {
  constructor(viewer, steps_element, { load_step_scene, on_step_change } = {}) {
    Object.assign(this, { viewer, steps_element, load_step_scene, on_step_change, steps: [], scene_cache: new Map(), current_step_index: -1, final_scene: null, is_playing: false });
    steps_element.classList.add('vc-steps');
    steps_element.innerHTML = `
      <div class="vc-steps-head">
        <button class="vc-steps-nav" data-step="-1" title="Previous step · ←">${icons.step_previous}</button>
        <button class="vc-steps-play" title="Replay build · Space">${icons.play}</button>
        <button class="vc-steps-nav" data-step="1" title="Next step · →">${icons.step_next}</button>
        <div class="vc-steps-cap"><span class="vc-steps-n"></span><span class="vc-steps-d"></span></div>
        <span class="vc-steps-meta"></span>
        <button class="vc-steps-final vc-mini" title="Show final model">Final</button>
      </div>
      <div class="vc-steps-track"></div>`;
    this.track_element = steps_element.querySelector('.vc-steps-track');
    this.play_button = steps_element.querySelector('.vc-steps-play');
    this.play_button.addEventListener('click', () => this.toggle_playback());
    steps_element.querySelector('.vc-steps-final').addEventListener('click', () => this.show_final_step());
    steps_element.querySelectorAll('.vc-steps-nav').forEach((navigation_button) => navigation_button.addEventListener('click', () => this.step_by(+navigation_button.dataset.step)));
    steps_element.hidden = true;
  }

  set_steps(build_steps, { final_scene = null } = {}) {
    this.stop();
    this.steps = Array.isArray(build_steps) ? build_steps.slice().sort((first_step, second_step) => (first_step.index ?? 0) - (second_step.index ?? 0)) : [];
    this.scene_cache.clear();
    this.final_scene = final_scene;
    this.current_step_index = this.steps.length - 1;
    this.steps_element.hidden = this.steps.length < 2;
    this.track_element.replaceChildren(...this.steps.map((build_step, step_index) => this.create_step_button(build_step, step_index)));
    this.update_caption();
  }

  create_step_button(build_step, step_index) {
    const step_button = create_element('button', 'vc-step', `${icon_for_operation(build_step.icon || build_step.op)}<span class="vc-step-i">${step_index + 1}</span><span class="vc-step-op">${(build_step.label || build_step.op || 'step').replace(/_/g, ' ')}</span>`);
    step_button.title = build_step.description || build_step.op || '';
    if (!build_step.scene_url && step_index !== this.steps.length - 1) step_button.classList.add('na');
    step_button.addEventListener('click', () => this.go_to_step(step_index));
    return step_button;
  }

  async scene_for_step(step_index) {
    if (step_index < 0 || step_index >= this.steps.length) return null;
    if (!this.scene_cache.has(step_index)) this.scene_cache.set(step_index, await this.fetch_step_scene(step_index));
    return this.scene_cache.get(step_index);
  }

  async fetch_step_scene(step_index) {
    const build_step = this.steps[step_index];
    if (build_step.scene) return build_step.scene;
    if (step_index === this.steps.length - 1 && this.final_scene) return this.final_scene;
    if (!build_step.scene_url || !this.load_step_scene) return null;
    try { return await this.load_step_scene(build_step); } catch (load_error) { return null; }
  }

  async go_to_step(step_index) {
    if (step_index === this.current_step_index && !this.is_playing) return;
    const is_final_step = step_index === this.steps.length - 1;
    const step_scene = await this.scene_for_step(step_index);
    if (!step_scene) return this.viewer.flash('Save the model to replay its steps');
    this.current_step_index = step_index;
    this.viewer.load_scene(step_scene, { keep_camera: true, version_id: this.viewer.version_id });
    const previous_step_scene = step_index > 0 ? await this.scene_for_step(step_index - 1) : null;
    this.viewer.set_ghost(is_final_step ? null : previous_step_scene);
    this.update_caption();
    this.on_step_change?.(step_index, this.steps[step_index]);
  }

  show_final_step() {
    this.stop();
    this.go_to_step(this.steps.length - 1);
  }

  step_by(step_offset) {
    this.stop();
    const target_step_index = Math.max(0, Math.min(this.steps.length - 1, this.current_step_index + step_offset));
    if (target_step_index !== this.current_step_index) this.go_to_step(target_step_index);
  }

  toggle_playback() {
    if (this.is_playing) this.stop();
    else this.play();
  }

  async play() {
    if (this.steps.length < 2) return;
    this.set_playing(true);
    for (let step_index = this.current_step_index >= this.steps.length - 1 ? 0 : this.current_step_index + 1; this.is_playing && step_index < this.steps.length; step_index++) {
      if (await this.scene_for_step(step_index)) await this.go_to_step(step_index);
      await new Promise((resolve_after_delay) => setTimeout(resolve_after_delay, step_replay_interval_in_milliseconds));
    }
    this.stop();
  }

  stop() {
    this.set_playing(false);
  }

  set_playing(is_playing) {
    this.is_playing = is_playing;
    this.play_button.innerHTML = is_playing ? icons.pause : icons.play;
    this.steps_element.classList.toggle('playing', is_playing);
  }

  update_caption() {
    const current_step = this.steps[this.current_step_index];
    this.track_element.querySelectorAll('.vc-step').forEach((step_button, step_index) => {
      step_button.classList.toggle('on', step_index === this.current_step_index);
      step_button.classList.toggle('past', step_index < this.current_step_index);
    });
    if (!current_step) return;
    const find_in_steps_bar = (selector) => this.steps_element.querySelector(selector);
    find_in_steps_bar('.vc-steps-n').textContent = `Step ${this.current_step_index + 1} / ${this.steps.length}`;
    find_in_steps_bar('.vc-steps-d').textContent = current_step.description || current_step.op || '';
    find_in_steps_bar('.vc-steps-meta').textContent = [current_step.volume != null ? `${format_number(current_step.volume / 1000, 2)} cm³` : null, current_step.faces != null ? `${current_step.faces} faces` : null].filter(Boolean).join(' · ');
    find_in_steps_bar('.vc-steps-final').classList.toggle('on', this.current_step_index === this.steps.length - 1);
    this.track_element.querySelector('.vc-step.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
}
