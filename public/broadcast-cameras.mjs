import {
  TRACKS,
  TRACK_LENGTH,
  trackAt,
  halfWidthAt,
} from './simulation.mjs';

const CAMERA_MAPS = {
  bay: [
    { id:'bay-grid', label:'发车主直道', at:0.012, from:0.965, to:0.075, lane:-19, height:5.2, fov:42, style:'longlens', lookLead:10 },
    { id:'bay-marina', label:'滨海高速段', at:0.135, from:0.075, to:0.205, lane:25, height:7.5, fov:45, style:'trackside', lookLead:4 },
    { id:'bay-hairpin', label:'港湾发卡', at:0.292, from:0.205, to:0.365, lane:-18, height:8.2, fov:50, style:'corner', lookLead:0 },
    { id:'bay-bridge', label:'跨海爬升桥', at:0.445, from:0.365, to:0.505, lane:18, height:14, fov:46, style:'high-trackside', lookLead:2 },
    { id:'bay-midfield', label:'中段高速切线', at:0.565, from:0.505, to:0.645, lane:-22, height:8.5, fov:43, style:'longlens', lookLead:8 },
    { id:'bay-tunnel', label:'岩壁隧道出口', at:0.735, from:0.645, to:0.775, lane:18, height:12.5, fov:43, style:'exit', lookLead:11 },
    { id:'bay-downhill', label:'下坡连续弯', at:0.835, from:0.775, to:0.915, lane:-23, height:12, fov:48, style:'corner', lookLead:3 },
    { id:'bay-final', label:'终点冲刺段', at:0.945, from:0.915, to:0.965, lane:20, height:6.5, fov:39, style:'longlens', lookLead:14 },
  ],
  ridge: [
    { id:'ridge-grid', label:'山脊发车区', at:0.015, from:0.955, to:0.085, lane:-18, height:6, fov:43, style:'longlens', lookLead:10 },
    { id:'ridge-climb', label:'山脊爬坡', at:0.13, from:0.085, to:0.225, lane:20, height:10, fov:46, style:'high-trackside', lookLead:5 },
    { id:'ridge-hairpin', label:'东北发卡', at:0.31, from:0.225, to:0.405, lane:-16, height:9, fov:52, style:'corner', lookLead:0 },
    { id:'ridge-crest', label:'山顶平台', at:0.465, from:0.405, to:0.555, lane:18, height:13, fov:47, style:'high-trackside', lookLead:4 },
    { id:'ridge-esses', label:'西侧连续弯', at:0.65, from:0.555, to:0.755, lane:-20, height:10, fov:50, style:'corner', lookLead:2 },
    { id:'ridge-tunnel', label:'山体隧道口', at:0.75, from:0.705, to:0.825, lane:15, height:7, fov:41, style:'exit', lookLead:10 },
    { id:'ridge-descent', label:'下山加速段', at:0.86, from:0.825, to:0.955, lane:22, height:9, fov:42, style:'longlens', lookLead:12 },
  ],
};

function wrap01(v) {
  let n = v % 1;
  if (n < 0) n += 1;
  return n;
}

function inWindow(v, from, to) {
  const x = wrap01(v), a = wrap01(from), b = wrap01(to);
  return a <= b ? x >= a && x < b : x >= a || x < b;
}

export function broadcastTemplates(trackId) {
  return CAMERA_MAPS[trackId] ?? CAMERA_MAPS.bay;
}

export function broadcastTemplateById(trackId, id) {
  return broadcastTemplates(trackId).find(template => template.id === id) ?? null;
}

export function resolveBroadcastTemplate(trackId, s) {
  const ratio = wrap01(s / TRACK_LENGTH);
  const templates = broadcastTemplates(trackId);
  return templates.find(template => inWindow(ratio, template.from, template.to)) ?? templates[0];
}

export function nextBroadcastTemplate(trackId, currentId, delta = 1) {
  const templates = broadcastTemplates(trackId);
  let index = templates.findIndex(template => template.id === currentId);
  if (index < 0) index = 0;
  index = (index + delta + templates.length) % templates.length;
  return templates[index];
}

// Returns a fixed television-style camera station and a dynamic look target.
// The station is anchored to the map; only its pan target follows the race.
// This avoids the "every camera is secretly a chase cam" feel.
export function broadcastPose(trackId, template, targetS, targetLane = 0, options = {}) {
  const t = template ?? resolveBroadcastTemplate(trackId, targetS);
  const anchorS = t.at * TRACK_LENGTH;
  const signedLane = Math.sign(t.lane || 1) * Math.max(
    Math.abs(t.lane || 0),
    halfWidthAt(anchorS) + 7,
  );
  const anchor = trackAt(anchorS, signedLane);
  const target = trackAt(targetS + (t.lookLead || 0), targetLane);
  const camera = {
    x: anchor.x,
    y: anchor.y + t.height,
    z: anchor.z,
  };

  if (t.style === 'high-trackside') {
    camera.y += 4;
  } else if (t.style === 'exit') {
    // Pull slightly backwards along the track for a compressed tunnel-exit shot.
    const back = trackAt(anchorS - 8, signedLane);
    camera.x = back.x;
    camera.z = back.z;
  } else if (t.style === 'longlens') {
    const back = trackAt(anchorS - 14, signedLane);
    camera.x = back.x;
    camera.z = back.z;
  }

  const look = {
    x: target.x,
    y: target.y + (options.lookHeight ?? 1.25),
    z: target.z,
  };

  return {
    id:t.id,
    label:t.label,
    style:t.style,
    fov:options.fov ?? t.fov,
    camera,
    look,
  };
}

export function broadcastMap(trackId) {
  const track = TRACKS[trackId] ?? TRACKS.bay;
  return {
    trackId:track.id,
    trackName:track.name,
    templates:broadcastTemplates(track.id).map(({ id, label, at, from, to, style, fov }) => ({
      id, label, at, from, to, style, fov,
    })),
  };
}
