// ============================================================
// WaterSystem — Three.js 水面 + Kelvin 船行尾迹
// 适用：Three.js r128（与本项目游戏同版本），也可用于更新版本。
//
// 原理
//  1) 尾迹纹理（RenderTarget，ping-pong 双缓冲）：
//     每帧先把旧尾迹按时间衰减（exp(-dt / fadeTime)），再把每条船的
//     Kelvin 尾迹“盖章”加上去。尾迹留在船驶过的位置，随时间慢慢淡化。
//  2) 水面 Shader：
//     - 顶点：小幅正弦波做平静波纹，再叠加尾迹纹理的高度；
//     - 片元：法线 = 波纹解析导数 + 尾迹纹理梯度；光照（漫反射+高光+
//       Fresnel 天光）；尾迹强的地方出泡沫（带噪声破碎）。
//
// 性能
//  - 尾迹纹理 512x512，每帧一次全屏 pass（最多 4 条船），与水面大小无关。
//  - 水面 128x128 段，顶点只做 3 个 sin + 1 次尾迹采样。
//  - 尾迹用 8bit 纹理，兼容性最好；淡化靠每帧乘衰减系数。
//
// 集成方法（以本项目 lujiazui-explorer 为例）
//  1) 把本文件拷到游戏目录，在 index.html 里用 script 标签引入 WaterSystem.js。
//  2) 创建：
//       const water = new WaterSystem(renderer, {
//         minX: -308, maxX: -68, minZ: -210, maxZ: 210, // 黄浦江水域范围
//         baseColor: 0x07243d
//       });
//       scene.add(water.mesh);
//       water.mesh.position.y = -0.55; // 与原 riverMesh 同高
//     注意：要先移除/替换游戏里旧的 riverMesh，否则两层水面会重叠。
//  3) 每帧调用（在 animate 循环里）：
//       water.update(dt, boats);  // boats: [{position, heading, speed}]
//       water.tick(dt);
//     其中 boats 是游戏里的船：position 为船的世界坐标 Vector3，
//     heading 为船头朝向（绕 Y 轴弧度，与船 mesh 的 rotation.y 一致），
//     speed 为前进速度（米/秒）。船静止时 speed=0，不产生尾迹。
// ============================================================

class WaterSystem {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;

    // 水面覆盖的世界范围（不必是方形；尾迹 UV 按 x/z 各自等比映射）
    this.minX = opts.minX !== undefined ? opts.minX : -200;
    this.maxX = opts.maxX !== undefined ? opts.maxX : 200;
    this.minZ = opts.minZ !== undefined ? opts.minZ : -200;
    this.maxZ = opts.maxZ !== undefined ? opts.maxZ : 200;
    this.sizeX = this.maxX - this.minX; // 东西向边长（米）
    this.sizeZ = this.maxZ - this.minZ; // 南北向边长（米）
    this.wakeRes = opts.wakeRes || 512;        // 尾迹纹理分辨率
    this.segments = opts.segments || 128;      // 水面网格分段
    this.fadeTime = opts.fadeTime || 10;        // 尾迹淡化时间常数（秒）
    this.wakeHeight = opts.wakeHeight || 0.18; // 尾迹顶点抬升（米）
    this.baseColor = new THREE.Color(opts.baseColor !== undefined ? opts.baseColor : 0x1d4e79);
    this.skyColor = new THREE.Color(opts.skyColor !== undefined ? opts.skyColor : 0x9fc8e8);
    this.sunDir = (opts.sunDir || new THREE.Vector3(0.5, 0.8, 0.3)).clone().normalize();
    this.maxBoats = 4;

    // ---------- 尾迹双缓冲 ----------
    const rtOpts = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false
    };
    this.wakeA = new THREE.WebGLRenderTarget(this.wakeRes, this.wakeRes, rtOpts);
    this.wakeB = new THREE.WebGLRenderTarget(this.wakeRes, this.wakeRes, rtOpts);
    this._clearTarget(this.wakeA);
    this._clearTarget(this.wakeB);
    this.wakeRead = this.wakeA;
    this.wakeWrite = this.wakeB;

    // ---------- 尾迹更新：全屏 pass（衰减旧尾迹 + 盖 Kelvin 尾迹） ----------
    this.wakeScene = new THREE.Scene();
    this.wakeCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.wakeUniforms = {
      tPrev: { value: this.wakeRead.texture },
      uDecay: { value: 1.0 },
      uDt: { value: 0.016 },
      uBoatCount: { value: 0 },
      uBoatPos: { value: [new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2(), new THREE.Vector2()] },
      uBoatDir: { value: [new THREE.Vector2(1, 0), new THREE.Vector2(1, 0), new THREE.Vector2(1, 0), new THREE.Vector2(1, 0)] },
      uBoatSpeed: { value: [0, 0, 0, 0] },
      uWorldSize: { value: new THREE.Vector2(this.sizeX, this.sizeZ) }
    };
    this.wakeMat = new THREE.ShaderMaterial({
      uniforms: this.wakeUniforms,
      vertexShader: [
        'varying vec2 vUv;',
        'void main() {',
        '  vUv = uv;',
        '  gl_Position = vec4(position.xy, 0.0, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'precision highp float;',
        'varying vec2 vUv;',
        'uniform sampler2D tPrev;',
        'uniform float uDecay;',
        'uniform float uDt;',
        'uniform int uBoatCount;',
        'uniform vec2 uBoatPos[4];',
        'uniform vec2 uBoatDir[4];',
        'uniform float uBoatSpeed[4];',
        'uniform vec2 uWorldSize;',
        '',
        '// 单条船在该像素产生的 Kelvin 尾迹强度。',
        '// 坐标：以船为原点，x 沿船头前进方向（+为前方），y 为横向，单位米。',
        'float kelvinWake(vec2 uv, vec2 bPos, vec2 bDir, float speed) {',
        '  if (speed < 0.3) return 0.0;',
        '  vec2 d = (uv - bPos) * uWorldSize;              // 像素相对船的世界偏移（米）',
        '  float x = dot(d, bDir);                          // 前进分量',
        '  float y = dot(d, vec2(-bDir.y, bDir.x));         // 横向分量',
        '  float behind = -x;                               // 船后距离（>0 为船后）',
        '  // 船头泡沫（船头附近的小范围）',
        '  float bowR = 2.5 + speed * 0.15;',
        '  float bow = exp(-(x*x + y*y) / (bowR*bowR));',
        '  if (behind <= 0.0) return bow;',
        '  float g = 9.81;',
        '  float v = clamp(speed, 0.5, 15.0);',
        '  float lambdaT = 6.28318 * v * v / g;             // 横波波长（米），随船速变大',
        '  float kT = 6.28318 / lambdaT;                    // 横波波数',
        '  // 发散波：V 形两臂，夹角约 19.47°，tan = 0.3535',
        '  float armSlope = 0.3535;',
        '  float armDist = abs(abs(y) - armSlope * behind);',
        '  float armWidth = 0.9 + behind * 0.04;',
        '  float divergent = exp(-armDist*armDist / (armWidth*armWidth))',
        '                  * (0.5 + 0.5 * sin(behind * kT * 0.9));',
        '  // 横波：船后弧形波纹，中心线最强，随距离衰减',
        '  float transWidth = 3.5 + behind * 0.08;',
        '  float transverse = exp(-y*y / (transWidth*transWidth))',
        '                   * (0.5 + 0.5 * sin(behind * kT))',
        '                   * exp(-behind / 70.0);',
        '  float wakeLen = 50.0 + v * 10.0;                  // 尾迹长度随船速变大',
        '  float envelope = exp(-behind / wakeLen);',
        '  float speedF = clamp(v / 6.0, 0.0, 1.2);',
        '  return (divergent * 0.55 + transverse * 0.3) * envelope * speedF + bow * speedF;',
        '}',
        '',
        'void main() {',
        '  float w = texture2D(tPrev, vUv).r * uDecay;',
        '  float stamp = 0.025 * clamp(uDt * 60.0, 0.0, 2.0);',
        '  for (int i = 0; i < 4; i++) {',
        '    if (i >= uBoatCount) break;',
        '    w += kelvinWake(vUv, uBoatPos[i], uBoatDir[i], uBoatSpeed[i]) * stamp;',
        '  }',
        '  w = clamp(w, 0.0, 1.0);',
        '  gl_FragColor = vec4(w, w, w, 1.0);',
        '}'
      ].join('\n')
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.wakeMat);
    quad.frustumCulled = false;
    this.wakeScene.add(quad);

    // ---------- 水面 ----------
    const geo = new THREE.PlaneGeometry(this.sizeX, this.sizeZ, this.segments, this.segments);
    geo.rotateX(-Math.PI / 2); // 放到 XZ 平面
    const cx = (this.minX + this.maxX) / 2;
    const cz = (this.minZ + this.maxZ) / 2;
    geo.translate(cx, 0, cz);
    this.waterUniforms = {
      uTime: { value: 0 },
      uWakeTex: { value: this.wakeRead.texture },
      uWakeMin: { value: new THREE.Vector2(this.minX, this.minZ) },
      uWakeSize: { value: new THREE.Vector2(this.sizeX, this.sizeZ) },
      uWakeRes: { value: this.wakeRes },
      uWakeHeight: { value: this.wakeHeight },
      uBaseColor: { value: this.baseColor },
      uSkyColor: { value: this.skyColor },
      uSunDir: { value: this.sunDir }
    };
    this.waterMat = new THREE.ShaderMaterial({
      uniforms: this.waterUniforms,
      vertexShader: [
        'uniform float uTime;',
        'uniform sampler2D uWakeTex;',
        'uniform vec2 uWakeMin;',
        'uniform vec2 uWakeSize;',
        'uniform float uWakeHeight;',
        'varying vec3 vWorldPos;',
        'varying vec2 vWakeUv;',
        'varying float vWake;',
        'void main() {',
        '  vec3 pos = position;',
        '  vec2 wxz = pos.xz;  // 水面网格已在 XZ 平面，mesh 在原点',
        '  vWakeUv = (wxz - uWakeMin) / uWakeSize;',
        '  float wake = texture2D(uWakeTex, vWakeUv).r;',
        '  vWake = wake;',
        '  // 平静小波纹：3 个正弦波叠加，幅度小（厘米级）',
        '  float h = 0.0;',
        '  h += 0.035 * sin(dot(wxz, vec2(0.11, 0.07)) + uTime * 0.9);',
        '  h += 0.022 * sin(dot(wxz, vec2(-0.06, 0.13)) + uTime * 1.3 + 1.7);',
        '  h += 0.014 * sin(dot(wxz, vec2(0.21, -0.16)) + uTime * 1.9 + 4.2);',
        '  // 尾迹抬升（尾迹纹理自带波形起伏）',
        '  h += wake * uWakeHeight;',
        '  pos.y += h;',
        '  vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'precision highp float;',
        'uniform float uTime;',
        'uniform sampler2D uWakeTex;',
        'uniform vec2 uWakeSize;',
        'uniform float uWakeRes;',
        'uniform vec3 uBaseColor;',
        'uniform vec3 uSkyColor;',
        'uniform vec3 uSunDir;',
        'varying vec3 vWorldPos;',
        'varying vec2 vWakeUv;',
        'varying float vWake;',
        '',
        'float hash(vec2 p) {',
        '  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);',
        '}',
        'float noise(vec2 p) {',
        '  vec2 i = floor(p);',
        '  vec2 f = fract(p);',
        '  vec2 u = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),',
        '             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);',
        '}',
        '',
        'void main() {',
        '  vec2 wxz = vWorldPos.xz;',
        '  float t = uTime;',
        '  // --- 法线：平静波纹的解析导数（与顶点位移用的波形一致） ---',
        '  vec2 d1 = vec2(0.11, 0.07);',
        '  vec2 d2 = vec2(-0.06, 0.13);',
        '  vec2 d3 = vec2(0.21, -0.16);',
        '  float ph1 = dot(wxz, d1) + t * 0.9;',
        '  float ph2 = dot(wxz, d2) + t * 1.3 + 1.7;',
        '  float ph3 = dot(wxz, d3) + t * 1.9 + 4.2;',
        '  float dhdx = 0.035 * d1.x * cos(ph1) + 0.022 * d2.x * cos(ph2) + 0.014 * d3.x * cos(ph3);',
        '  float dhdz = 0.035 * d1.y * cos(ph1) + 0.022 * d2.y * cos(ph2) + 0.014 * d3.y * cos(ph3);',
        '  // --- 尾迹对法线的扰动：尾迹纹理梯度 ---',
        '  float texel = 1.0 / uWakeRes;',
        '  float wx0 = texture2D(uWakeTex, vWakeUv + vec2(-texel, 0.0)).r;',
        '  float wx1 = texture2D(uWakeTex, vWakeUv + vec2( texel, 0.0)).r;',
        '  float wz0 = texture2D(uWakeTex, vWakeUv + vec2(0.0, -texel)).r;',
        '  float wz1 = texture2D(uWakeTex, vWakeUv + vec2(0.0,  texel)).r;',
        '  float worldPerTexelX = uWakeSize.x / uWakeRes;',
        '  float worldPerTexelZ = uWakeSize.y / uWakeRes;',
        '  float gw = 0.6;',
        '  dhdx += (wx1 - wx0) / (2.0 * worldPerTexelX) * gw;',
        '  dhdz += (wz1 - wz0) / (2.0 * worldPerTexelZ) * gw;',
        '  vec3 N = normalize(vec3(-dhdx, 1.0, -dhdz));',
        '  // --- 光照 ---',
        '  vec3 V = normalize(cameraPosition - vWorldPos);',
        '  vec3 L = normalize(uSunDir);',
        '  float diff = max(dot(N, L), 0.0);',
        '  vec3 H = normalize(L + V);',
        '  float spec = pow(max(dot(N, H), 0.0), 90.0) * 0.9;',
        '  float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);',
        '  vec3 col = mix(uBaseColor, uSkyColor, 0.25 + 0.55 * fres);',
        '  col += vec3(1.0, 0.95, 0.85) * diff * 0.35;',
        '  col += vec3(1.0) * spec;',
        '  // --- 泡沫：尾迹强的地方，带噪声破碎 ---',
        '  float n = noise(wxz * 0.8 + vec2(t * 0.15, -t * 0.1));',
        '  float foamBand = smoothstep(0.5, 0.9, vWake + (n - 0.5) * 0.35);',
        '  col = mix(col, vec3(0.95, 0.98, 1.0), foamBand * 0.65);',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n')
    });
    this.mesh = new THREE.Mesh(geo, this.waterMat);
    this.mesh.frustumCulled = false;
  }

  _clearTarget(rt) {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.clear();
    this.renderer.setRenderTarget(prev);
  }

  // boats: [{ position: THREE.Vector3 (世界坐标), heading: 船头朝向弧度（绕 Y，与 mesh.rotation.y 一致）, speed: 前进速度 米/秒 }]
  update(dt, boats) {
    const u = this.wakeUniforms;
    u.tPrev.value = this.wakeRead.texture;
    u.uDecay.value = Math.exp(-dt / this.fadeTime);
    u.uDt.value = dt;
    const n = Math.min(boats.length, this.maxBoats);
    u.uBoatCount.value = n;
    for (let i = 0; i < this.maxBoats; i++) {
      if (i < n) {
        const b = boats[i];
        // 世界坐标 -> 尾迹 UV
        u.uBoatPos.value[i].set(
          (b.position.x - this.minX) / this.sizeX,
          (b.position.z - this.minZ) / this.sizeZ
        );
        // 航向 -> 尾迹 UV 空间的前进方向（UV 与世界 XZ 同向、等比）
        u.uBoatDir.value[i].set(Math.sin(b.heading), Math.cos(b.heading)).normalize();
        u.uBoatSpeed.value[i] = b.speed;
      } else {
        u.uBoatSpeed.value[i] = 0;
      }
    }
    // 渲染到写缓冲（ping-pong）
    const prevRT = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.wakeWrite);
    this.renderer.render(this.wakeScene, this.wakeCam);
    this.renderer.setRenderTarget(prevRT);
    const tmp = this.wakeRead;
    this.wakeRead = this.wakeWrite;
    this.wakeWrite = tmp;
    // 水面采样最新的尾迹纹理
    this.waterUniforms.uWakeTex.value = this.wakeRead.texture;
  }

  // 每帧调用，推进水面时间
  tick(dt) {
    this.waterUniforms.uTime.value += dt;
  }
}
