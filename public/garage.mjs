import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = id => document.getElementById(id);
const canvas = $('model'), stage = canvas.parentElement;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#29464e');
const camera = new THREE.PerspectiveCamera(38, 1, .1, 100);
let renderer;
try { renderer = new THREE.WebGLRenderer({canvas, antialias:true}); }
catch (error) { $('status').textContent = '无法启动 WebGL 2，请使用支持 3D 的浏览器。'; throw error; }
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
scene.add(new THREE.HemisphereLight('#fffae9', '#506b7e', 2.4));
for (const [position, color, intensity] of [[[3,6,5], '#fff1ce',3], [[-4,3,-3],'#b0ebf3',2]]) {
  const light = new THREE.DirectionalLight(color, intensity);light.position.set(...position);scene.add(light);
}
const floor = new THREE.Mesh(new THREE.CircleGeometry(6,64),new THREE.MeshStandardMaterial({color:'#244149',roughness:.85}));
floor.rotation.x=-Math.PI/2;floor.position.y=-.025;scene.add(floor);
const shadowCanvas = document.createElement('canvas');shadowCanvas.width=128;shadowCanvas.height=128;
const ctx=shadowCanvas.getContext('2d'),gradient=ctx.createRadialGradient(64,64,8,64,64,62);
gradient.addColorStop(0,'rgba(0,0,0,.4)');gradient.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=gradient;ctx.fillRect(0,0,128,128);
const contactMat=new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(shadowCanvas),transparent:true,depthWrite:false});
for(const [x,z,w,d] of [[-1.1,0,3.7,4.5],[1.8,.1,2.1,2.1]]){const m=new THREE.Mesh(new THREE.PlaneGeometry(w,d),contactMat);m.rotation.x=-Math.PI/2;m.position.set(x,.002,z);scene.add(m);}

const loader = new GLTFLoader();
let current=null, generation=0, selected=null, yaw=.55, pitch=.32, distance=10.8, auto=false, drag=null;
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
function dispose(root) {
  const geometries=new Set(),materials=new Set(),textures=new Set();
  root.traverse(o=>{if(o.geometry)geometries.add(o.geometry);for(const m of (Array.isArray(o.material)?o.material:[o.material]))if(m){materials.add(m);for(const v of Object.values(m))if(v?.isTexture)textures.add(v);}});
  for(const t of textures){t.dispose();t.source?.data?.close?.();}for(const m of materials)m.dispose();for(const g of geometries)g.dispose();
}
function setAuto(value){auto=value&&!reducedMotion.matches;$('rotate').setAttribute('aria-pressed',String(auto));$('rotate').textContent=auto?'停止旋转':'自动旋转';}
reducedMotion.addEventListener('change',()=>{if(reducedMotion.matches)setAuto(false);});
async function select(entry) {
  selected=entry;const ticket=++generation;$('retry').hidden=true;$('status').textContent='正在加载实际 GLB…';
  if(current){scene.remove(current);dispose(current);current=null;}
  $('title').textContent=entry.name;$('description').textContent=entry.description;$('spec').textContent='';
  for(const button of $('roster').children)button.setAttribute('aria-pressed',String(button.dataset.id===entry.id));
  $('kart-download').href=entry.kart;$('driver-download').href=entry.driver;
  const loaded=await Promise.allSettled([loader.loadAsync(entry.kart),loader.loadAsync(entry.driver)]);
  if(ticket!==generation){for(const r of loaded)if(r.status==='fulfilled')dispose(r.value.scene);return;}
  if(loaded.some(r=>r.status==='rejected')){for(const r of loaded)if(r.status==='fulfilled')dispose(r.value.scene);$('status').textContent='模型加载失败，可重试或切换其他组合。';$('retry').hidden=false;return;}
  current=new THREE.Group();
  loaded.forEach((r,i)=>{r.value.scene.position.set(i===0?-1.1:1.8,0,i===0?0:.1);current.add(r.value.scene);});
  scene.add(current);yaw=.55;pitch=.32;distance=10.8;
  let triangles=0,meshes=0;current.traverse(o=>{if(o.isMesh){meshes++;triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;}});
  $('spec').textContent=`${triangles.toLocaleString()} 三角面 · ${meshes} 网格 · 静态候选`;
  $('status').textContent='实际 GLB · 拖动查看前后轮廓';
  canvas.dataset.loaded=entry.id;
}
canvas.addEventListener('pointerdown',e=>{if(drag)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY};canvas.setPointerCapture(e.pointerId);setAuto(false);});
canvas.addEventListener('pointermove',e=>{if(drag?.id!==e.pointerId)return;yaw-=(e.clientX-drag.x)*.008;pitch=THREE.MathUtils.clamp(pitch+(e.clientY-drag.y)*.005,.08,.9);drag.x=e.clientX;drag.y=e.clientY;});
for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,e=>{if(drag?.id===e.pointerId)drag=null;});
window.addEventListener('blur',()=>{drag=null;});
canvas.addEventListener('wheel',e=>{e.preventDefault();distance=THREE.MathUtils.clamp(distance+e.deltaY*.008,7,17);},{passive:false});
canvas.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key))return;e.preventDefault();setAuto(false);if(e.key==='ArrowLeft')yaw-=.12;if(e.key==='ArrowRight')yaw+=.12;if(e.key==='ArrowUp')distance=Math.max(7,distance-.5);if(e.key==='ArrowDown')distance=Math.min(17,distance+.5);});
$('front').onclick=()=>{yaw=0;pitch=.26;setAuto(false);};$('rear').onclick=()=>{yaw=Math.PI;pitch=.32;setAuto(false);};
$('rotate').onclick=()=>setAuto(!auto);$('retry').onclick=()=>selected&&select(selected);
function resize(){const {width,height}=stage.getBoundingClientRect();renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();}
new ResizeObserver(resize).observe(stage);resize();
let last=0;
renderer.setAnimationLoop(now=>{const dt=Math.min(.05,(now-last)/1000);last=now;if(document.hidden)return;if(auto)yaw+=dt*.2;const responsiveDistance=distance*Math.max(1,1.2/camera.aspect);camera.position.set(Math.sin(yaw)*responsiveDistance*Math.cos(pitch),1+Math.sin(pitch)*responsiveDistance,Math.cos(yaw)*responsiveDistance*Math.cos(pitch));camera.lookAt(.1,1,0);renderer.render(scene,camera);});
try {
  const response=await fetch('/assets/models/roster.json');if(!response.ok)throw new Error('catalog');
  const roster=await response.json();
  for(const entry of roster){const button=document.createElement('button');button.dataset.id=entry.id;const swatch=document.createElement('i');swatch.style.background=entry.color;button.append(swatch,document.createTextNode(entry.name));button.onclick=()=>select(entry);$('roster').append(button);}
  await select(roster.find(e=>e.id===location.hash.slice(1))??roster[0]);
}catch(error){$('status').textContent='车库目录加载失败，请刷新页面。';}
