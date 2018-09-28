
//export * from "./Actions.js";
//export * from "./AnimationPath.js";
//export * from "./Annotation.js";
export * from "./defines.js";
export * from "./Enum.js";
export * from "./EventDispatcher.js";
export * from "./Features.js";
//export * from "./KeyCodes.js";
export * from "./LRU.js";
//export * from "./PointCloudGreyhoundGeometry.js";
//export * from "./PointCloudGreyhoundGeometryNode.js";
export * from "./PointCloudOctree.js";
export * from "./PointCloudOctreeGeometry.js";
export * from "./PointCloudTree.js";
export * from "./Points.js";
export * from "./Potree_update_visibility.js";
export * from "./PotreeRenderer.js";
//export * from "./ProfileRequest.js";
//export * from "./TextSprite.js";
export * from "./utils.js";
export * from "./Version.js";
export * from "./WorkerPool.js";
export * from "./XHRFactory.js";

export * from "./materials/ClassificationScheme.js";
export * from "./materials/EyeDomeLightingMaterial.js";
export * from "./materials/Gradients.js";
export * from "./materials/NormalizationEDLMaterial.js";
export * from "./materials/NormalizationMaterial.js";
export * from "./materials/PointCloudMaterial.js";

export * from "./loader/POCLoader.js";
//export * from "./loader/GreyhoundBinaryLoader.js";
//export * from "./loader/GreyhoundLoader.js";
export * from "./loader/PointAttributes.js";

//export * from "./utils/Box3Helper.js";
//export * from "./utils/ClippingTool.js";
//export * from "./utils/ClipVolume.js";
//export * from "./utils/GeoTIFF.js";
//export * from "./utils/Measure.js";
//export * from "./utils/MeasuringTool.js";
//export * from "./utils/Message.js";
export * from "./utils/PointCloudSM.js";
//export * from "./utils/PolygonClipVolume.js";
//export * from "./utils/Profile.js";
//export * from "./utils/ProfileTool.js";
//export * from "./utils/ScreenBoxSelectTool.js";
//export * from "./utils/SpotLightHelper.js";
export * from "./utils/toInterleavedBufferAttribute.js";
//export * from "./utils/TransformationTool.js";
//export * from "./utils/Volume.js";
//export * from "./utils/VolumeTool.js";

//export * from "./viewer/viewer.js";
//export * from "./viewer/Scene.js";

import "./extensions/OrthographicCamera.js";
import "./extensions/PerspectiveCamera.js";
import "./extensions/Ray.js";

//import {PointColorType} from "./defines";
//import {Enum} from "./Enum";
import {LRU} from "./LRU";
import {POCLoader} from "./loader/POCLoader";
import {GreyhoundLoader} from "./loader/GreyhoundLoader";
import {PointCloudOctree} from "./PointCloudOctree";
//import {WorkerPool} from "./WorkerPool";

//export const workerPool = new WorkerPool();

export const version = {
	major: 1,
	minor: 6,
	suffix: ''
};

export let lru = new LRU();

console.log('PotreeCore ' + version.major + '.' + version.minor + version.suffix);

export let pointBudget = 1 * 1000 * 1000;
export let framenumber = 0;
export let numNodesLoading = 0;
export let maxNodesLoading = 4;

export const debug = {};

const scriptPath = '';

/*
let scriptPath = "";

if (document.currentScript.src) {
	scriptPath = new URL(document.currentScript.src + '/..').href;
	if (scriptPath.slice(-1) === '/') {
		scriptPath = scriptPath.slice(0, -1);
	}
} else {
	//console.error('Potree was unable to find its script path using document.currentScript. Is Potree included with a script tag? Does your browser support this function?');
	scriptPath = '';
}
*/
let resourcePath = scriptPath + '/resources';

export {scriptPath, resourcePath};


export function loadPointCloud(path, name, callback){
	let loaded = function(pointcloud){
		pointcloud.name = name;
		callback({type: 'pointcloud_loaded', pointcloud: pointcloud});
	};

	// load pointcloud
	if (!path){
		// TODO: callback? comment? Hello? Bueller? Anyone?
	} else if (path.indexOf('greyhound://') === 0){
		// We check if the path string starts with 'greyhound:', if so we assume it's a greyhound server URL.
		GreyhoundLoader.load(path, function (geometry) {
			if (!geometry) {
				//callback({type: 'loading_failed'});
				console.error(new Error(`failed to load point cloud from URL: ${path}`));
			} else {
				let pointcloud = new PointCloudOctree(geometry);
				loaded(pointcloud);
			}
		});
	} else if (path.indexOf('cloud.js') > 0) {
		POCLoader.load(path, function (geometry) {
			if (!geometry) {
				//callback({type: 'loading_failed'});
				console.error(new Error(`failed to load point cloud from URL: ${path}`));
			} else {
				let pointcloud = new PointCloudOctree(geometry);
				loaded(pointcloud);
			}
		});
	} else if (path.indexOf('.vpc') > 0) {
		PointCloudArena4DGeometry.load(path, function (geometry) {
			if (!geometry) {
				//callback({type: 'loading_failed'});
				console.error(new Error(`failed to load point cloud from URL: ${path}`));
			} else {
				let pointcloud = new PointCloudArena4D(geometry);
				loaded(pointcloud);
			}
		});
	} else {
		//callback({'type': 'loading_failed'});
		console.error(new Error(`failed to load point cloud from URL: ${path}`));
	}
};
