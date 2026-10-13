// Upstream portions adapted from video2webxr: ISC; see NOTICE.md and licenses/.
// Original VRWatch additions/modifications: MPL-2.0.
// Projection ids and labels, in dropdown order. Kept free of three.js so the popup can use it.
export const PROJECTION_LABELS = [
    ['EAC', '360° EAC (YouTube default)'],
    ['EAC_LR', '360° EAC 3D'],
    ['CUBE', '360° cubemap'],
    ['360', '360° equirectangular'],
    ['360_TB', '360° 3D top/bottom'],
    ['360_LR', '360° 3D side by side'],
    ['180', '180°'],
    ['180_LR', '180° 3D side by side'],
    ['FLAT', 'Flat screen'],
];

// Most VR videos outside YouTube are 180° side by side
export const DEFAULT_PROJECTION = '180_LR';

// Compact labels for the controller-operated picker inside VR.
export const XR_PROJECTION_LABELS = [
    ['FLAT', 'Flat screen'],
    ['180', '180°'],
    ['180_LR', '180° 3D'],
    ['360', '360°'],
    ['360_LR', '360° 3D SBS'],
    ['360_TB', '360° 3D TB'],
    ['CUBE', '360° cubemap'],
    ['EAC', '360° EAC'],
    ['EAC_LR', '360° EAC 3D'],
];
