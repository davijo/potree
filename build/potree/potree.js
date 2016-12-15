"use strict";

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

function Potree() {}
Potree.version = {
	major: 1,
	minor: 4,
	suffix: "RC"
};

console.log("Potree " + Potree.version.major + "." + Potree.version.minor + Potree.version.suffix);

Potree.pointBudget = 1 * 1000 * 1000;

// contains WebWorkers with base64 encoded code
Potree.workers = {};

Potree.Shaders = {};

Potree.webgl = {
	shaders: {},
	vaos: {},
	vbos: {}
};

Potree.scriptPath = null;
if (document.currentScript.src) {
	Potree.scriptPath = new URL(document.currentScript.src + "/..").href;
} else {
	console.error("Potree was unable to find its script path using document.currentScript. Is Potree included with a script tag? Does your browser support this function?");
}

Potree.resourcePath = Potree.scriptPath + "/resources";

Potree.timerQueries = {};

Potree.timerQueriesEnabled = false;

Potree.startQuery = function (name, gl) {
	if (!Potree.timerQueriesEnabled) {
		return null;
	}

	if (Potree.timerQueries[name] === undefined) {
		Potree.timerQueries[name] = [];
	}

	var ext = gl.getExtension("EXT_disjoint_timer_query");
	var query = ext.createQueryEXT();
	ext.beginQueryEXT(ext.TIME_ELAPSED_EXT, query);

	Potree.timerQueries[name].push(query);

	return query;
};

Potree.endQuery = function (query, gl) {
	if (!Potree.timerQueriesEnabled) {
		return;
	}

	var ext = gl.getExtension("EXT_disjoint_timer_query");
	ext.endQueryEXT(ext.TIME_ELAPSED_EXT);
};

Potree.resolveQueries = function (gl) {
	if (!Potree.timerQueriesEnabled) {
		return;
	}

	var ext = gl.getExtension("EXT_disjoint_timer_query");

	for (var name in Potree.timerQueries) {
		var queries = Potree.timerQueries[name];

		if (queries.length > 0) {
			var query = queries[0];

			var available = ext.getQueryObjectEXT(query, ext.QUERY_RESULT_AVAILABLE_EXT);
			var disjoint = viewer.renderer.getContext().getParameter(ext.GPU_DISJOINT_EXT);

			if (available && !disjoint) {
				// See how much time the rendering of the object took in nanoseconds.
				var timeElapsed = ext.getQueryObjectEXT(query, ext.QUERY_RESULT_EXT);
				var miliseconds = timeElapsed / (1000 * 1000);

				console.log(name + ": " + miliseconds + "ms");
				queries.shift();
			}
		}

		if (queries.length === 0) {
			delete Potree.timerQueries[name];
		}
	}
};

Potree.loadPointCloud = function (path, name, callback) {

	var loaded = function loaded(pointcloud) {
		pointcloud.name = name;

		callback({ type: "pointcloud_loaded", pointcloud: pointcloud });
	};

	// load pointcloud
	if (!path) {} else if (path.indexOf("cloud.js") > 0) {
		Potree.POCLoader.load(path, function (geometry) {
			if (!geometry) {
				callback({ type: "loading_failed" });
			} else {
				var pointcloud = new Potree.PointCloudOctree(geometry);
				loaded(pointcloud);
			}
		}.bind(this));
	} else if (path.indexOf(".vpc") > 0) {
		Potree.PointCloudArena4DGeometry.load(path, function (geometry) {
			if (!geometry) {
				callback({ type: "loading_failed" });
			} else {
				var pointcloud = new Potree.PointCloudArena4D(geometry);
				loaded(pointcloud);
			}
		});
	} else {
		callback({ "type": "loading_failed" });
	}
};

Potree.updatePointClouds = function (pointclouds, camera, renderer) {

	if (!Potree.lru) {
		Potree.lru = new LRU();
	}

	for (var i = 0; i < pointclouds.length; i++) {
		var pointcloud = pointclouds[i];
		for (var j = 0; j < pointcloud.profileRequests.length; j++) {
			pointcloud.profileRequests[j].update();
		}
	}

	var result = Potree.updateVisibility(pointclouds, camera, renderer);

	for (var _i = 0; _i < pointclouds.length; _i++) {
		var _pointcloud = pointclouds[_i];
		_pointcloud.updateMaterial(_pointcloud.material, _pointcloud.visibleNodes, camera, renderer);
		_pointcloud.updateVisibleBounds();
	}

	Potree.getLRU().freeMemory();

	return result;
};

Potree.getLRU = function () {
	if (!Potree.lru) {
		Potree.lru = new LRU();
	}

	return Potree.lru;
};

function updateVisibilityStructures(pointclouds, camera, renderer) {
	var frustums = [];
	var camObjPositions = [];
	var priorityQueue = new BinaryHeap(function (x) {
		return 1 / x.weight;
	});

	for (var i = 0; i < pointclouds.length; i++) {
		var pointcloud = pointclouds[i];

		if (!pointcloud.initialized()) {
			continue;
		}

		pointcloud.numVisibleNodes = 0;
		pointcloud.numVisiblePoints = 0;
		pointcloud.visibleNodes = [];
		pointcloud.visibleGeometry = [];

		// frustum in object space
		camera.updateMatrixWorld();
		var frustum = new THREE.Frustum();
		var viewI = camera.matrixWorldInverse;
		var world = pointcloud.matrixWorld;
		var proj = camera.projectionMatrix;
		var fm = new THREE.Matrix4().multiply(proj).multiply(viewI).multiply(world);
		frustum.setFromMatrix(fm);
		frustums.push(frustum);

		// camera position in object space
		var view = camera.matrixWorld;
		var worldI = new THREE.Matrix4().getInverse(world);
		var camMatrixObject = new THREE.Matrix4().multiply(worldI).multiply(view);
		var camObjPos = new THREE.Vector3().setFromMatrixPosition(camMatrixObject);
		camObjPositions.push(camObjPos);

		if (pointcloud.visible && pointcloud.root !== null) {
			priorityQueue.push({ pointcloud: i, node: pointcloud.root, weight: Number.MAX_VALUE });
		}

		// hide all previously visible nodes
		//if(pointcloud.root instanceof Potree.PointCloudOctreeNode){
		//	pointcloud.hideDescendants(pointcloud.root.sceneNode);
		//}
		if (pointcloud.root.isTreeNode()) {
			pointcloud.hideDescendants(pointcloud.root.sceneNode);
		}

		for (var j = 0; j < pointcloud.boundingBoxNodes.length; j++) {
			pointcloud.boundingBoxNodes[j].visible = false;
		}
	}

	return {
		"frustums": frustums,
		"camObjPositions": camObjPositions,
		"priorityQueue": priorityQueue
	};
}

Potree.updateVisibility = function (pointclouds, camera, renderer) {
	var numVisibleNodes = 0;
	var numVisiblePoints = 0;

	var visibleNodes = [];
	var visibleGeometry = [];
	var unloadedGeometry = [];

	// calculate object space frustum and cam pos and setup priority queue
	var s = updateVisibilityStructures(pointclouds, camera, renderer);
	var frustums = s.frustums;
	var camObjPositions = s.camObjPositions;
	var priorityQueue = s.priorityQueue;

	while (priorityQueue.size() > 0) {
		var element = priorityQueue.pop();
		var node = element.node;
		var parent = element.parent;
		var pointcloud = pointclouds[element.pointcloud];

		var box = node.getBoundingBox();
		var frustum = frustums[element.pointcloud];
		var camObjPos = camObjPositions[element.pointcloud];

		var insideFrustum = frustum.intersectsBox(box);
		var visible = insideFrustum;
		visible = visible && !(numVisiblePoints + node.getNumPoints() > Potree.pointBudget);
		var maxLevel = pointcloud.maxLevel || Infinity;
		visible = visible && node.getLevel() < maxLevel;

		if (numVisiblePoints + node.getNumPoints() > Potree.pointBudget) {
			break;
		}

		if (!visible) {
			continue;
		}

		numVisibleNodes++;
		numVisiblePoints += node.getNumPoints();

		pointcloud.numVisibleNodes++;
		pointcloud.numVisiblePoints += node.getNumPoints();

		if (node.isGeometryNode() && (!parent || parent.isTreeNode())) {
			if (node.isLoaded()) {
				node = pointcloud.toTreeNode(node, parent);
			} else {
				unloadedGeometry.push(node);
				visibleGeometry.push(node);
			}
		}

		if (node.isTreeNode()) {
			Potree.getLRU().touch(node.geometryNode);
			node.sceneNode.visible = true;
			node.sceneNode.material = pointcloud.material;

			visibleNodes.push(node);
			pointcloud.visibleNodes.push(node);

			if (node.parent) {
				node.sceneNode.matrixWorld.multiplyMatrices(node.parent.sceneNode.matrixWorld, node.sceneNode.matrix);
			} else {
				node.sceneNode.matrixWorld.multiplyMatrices(pointcloud.matrixWorld, node.sceneNode.matrix);
			}

			if (pointcloud.showBoundingBox && !node.boundingBoxNode) {
				var boxHelper = new THREE.BoxHelper(node.sceneNode);
				pointcloud.add(boxHelper);
				pointcloud.boundingBoxNodes.push(boxHelper);
				node.boundingBoxNode = boxHelper;
				node.boundingBoxNode.matrixWorld.copy(node.sceneNode.matrixWorld);
			} else if (pointcloud.showBoundingBox) {
				node.boundingBoxNode.visible = true;
				node.boundingBoxNode.matrixWorld.copy(node.sceneNode.matrixWorld);
			} else if (!pointcloud.showBoundingBox && node.boundingBoxNode) {
				node.boundingBoxNode.visible = false;
			}
		}

		// add child nodes to priorityQueue
		var children = node.getChildren();
		for (var i = 0; i < children.length; i++) {
			var child = children[i];

			var sphere = child.getBoundingSphere();
			var distance = sphere.center.distanceTo(camObjPos);
			var radius = sphere.radius;

			var fov = camera.fov * Math.PI / 180;
			var slope = Math.tan(fov / 2);
			var projFactor = 0.5 * renderer.domElement.clientHeight / (slope * distance);
			var screenPixelRadius = radius * projFactor;

			if (screenPixelRadius < pointcloud.minimumNodePixelSize) {
				continue;
			}

			var weight = screenPixelRadius;
			if (distance - radius < 0) {
				weight = Number.MAX_VALUE;
			}

			priorityQueue.push({ pointcloud: element.pointcloud, node: child, parent: node, weight: weight });
		}
	} // end priority queue loop

	for (var _i2 = 0; _i2 < Math.min(5, unloadedGeometry.length); _i2++) {
		unloadedGeometry[_i2].load();
	}

	return { visibleNodes: visibleNodes, numVisiblePoints: numVisiblePoints };
};

Potree.Shader = function Shader(vertexShader, fragmentShader, program, uniforms) {
	_classCallCheck(this, Shader);

	this.vertexShader = vertexShader;
	this.fragmentShader = fragmentShader;
	this.program = program;
	this.uniforms = uniforms;
};

Potree.VBO = function VBO(name, id, attribute) {
	_classCallCheck(this, VBO);

	this.name = name;
	this.id = id;
	this.attribute = attribute;
};

Potree.VAO = function VAO(id, geometry, vbos) {
	_classCallCheck(this, VAO);

	this.id = id;
	this.geometry = geometry;
	this.vbos = vbos;
};

Potree.compileShader = function (gl, vertexShader, fragmentShader) {
	// VERTEX SHADER
	var vs = gl.createShader(gl.VERTEX_SHADER);
	{
		gl.shaderSource(vs, vertexShader);
		gl.compileShader(vs);

		var _success = gl.getShaderParameter(vs, gl.COMPILE_STATUS);
		if (!_success) {
			console.error("could not compile vertex shader:");

			var log = gl.getShaderInfoLog(vs);
			console.error(log, vertexShader);

			return;
		}
	}

	// FRAGMENT SHADER
	var fs = gl.createShader(gl.FRAGMENT_SHADER);
	{
		gl.shaderSource(fs, fragmentShader);
		gl.compileShader(fs);

		var _success2 = gl.getShaderParameter(fs, gl.COMPILE_STATUS);
		if (!_success2) {
			console.error("could not compile fragment shader:");
			console.error(fragmentShader);

			return;
		}
	}

	// PROGRAM
	var program = gl.createProgram();
	gl.attachShader(program, vs);
	gl.attachShader(program, fs);
	gl.linkProgram(program);
	var success = gl.getProgramParameter(program, gl.LINK_STATUS);
	if (!success) {
		console.error("could not compile shader:");
		console.error(vertexShader);
		console.error(fragmentShader);

		return;
	}

	gl.useProgram(program);

	var uniforms = {};
	{
		// UNIFORMS
		var n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);

		for (var i = 0; i < n; i++) {
			var uniform = gl.getActiveUniform(program, i);
			var name = uniform.name;
			var loc = gl.getUniformLocation(program, name);

			uniforms[name] = loc;
		}
	}

	var shader = new Potree.Shader(vertexShader, fragmentShader, program, uniforms);

	return shader;
};

// http://blog.tojicode.com/2012/10/oesvertexarrayobject-extension.html
Potree.createVAO = function (gl, geometry) {
	if (Potree.vaos[geometry.uuid] == !undefined) {
		return Potree.vaos[geometry.uuid];
	}

	var ext = gl.getExtension("OES_vertex_array_object");
	var id = ext.createVertexArrayOES();

	ext.bindVertexArrayOES(id);

	var vbos = {};
	for (var key in geometry.attributes) {
		var attribute = geometry.attributes[key];

		var type = gl.FLOAT;
		if (attribute.array instanceof Uint8Array) {
			type = gl.UNSIGNED_BYTE;
		} else if (attribute.array instanceof Uint16Array) {
			type = gl.UNSIGNED_SHORT;
		} else if (attribute.array instanceof Uint32Array) {
			type = gl.UNSIGNED_INT;
		} else if (attribute.array instanceof Int8Array) {
			type = gl.BYTE;
		} else if (attribute.array instanceof Int16Array) {
			type = gl.SHORT;
		} else if (attribute.array instanceof Int32Array) {
			type = gl.INT;
		} else if (attribute.array instanceof Float32Array) {
			type = gl.FLOAT;
		}

		var vbo = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
		gl.bufferData(gl.ARRAY_BUFFER, attribute.array, gl.STATIC_DRAW);
		//gl.enableVertexAttribArray(attributePointer);
		//gl.vertexAttribPointer(attributePointer, numElements, type, attribute.normalized, 0, 0);

		vbos[key] = new Potree.VBO(key, vbo, attribute);
	}

	ext.bindVertexArrayOES(null);

	var vao = new Potree.VAO(id, geometry, vbos);
	Potree.vaos[geometry.uuid] = vao;

	return vao;
};

Potree.renderPointcloud = function (pointcloud, camera, renderer) {
	var gl = renderer.context;
	var webgl = Potree.webgl;
	var material = pointcloud.material;

	if (gl.getExtension("OES_vertex_array_object") === null) {
		console.error("OES_vertex_array_object extension not supported");
		return;
	}

	if (material.needsUpdate) {
		Potree.pointcloudShader = Potree.compileShader(gl, material.vertexShader, material.fragmentShader);

		material.needsUpdate = false;
	}

	var shader = Potree.pointcloudShader;
	var uniforms = shader.uniforms;

	gl.useProgram(shader.program);

	gl.uniformMatrix4fv(uniforms["projectionMatrix"], false, camera.projectionMatrix.elements);
	gl.uniformMatrix4fv(uniforms["viewMatrix"], false, camera.matrixWorldInverse.elements);
	gl.uniform1f(uniforms["fov"], this.material.fov);
	gl.uniform1f(uniforms["screenWidth"], material.screenWidth);
	gl.uniform1f(uniforms["screenHeight"], material.screenHeight);
	gl.uniform1f(uniforms["spacing"], material.spacing);
	gl.uniform1f(uniforms["near"], material.near);
	gl.uniform1f(uniforms["far"], material.far);
	gl.uniform1f(uniforms["size"], material.size);
	gl.uniform1f(uniforms["minSize"], material.minSize);
	gl.uniform1f(uniforms["maxSize"], material.maxSize);
	gl.uniform1f(uniforms["octreeSize"], pointcloud.pcoGeometry.boundingBox.getSize().x);

	{
		var apPosition = gl.getAttribLocation(program, "position");
		var apColor = gl.getAttribLocation(program, "color");
		var apNormal = gl.getAttribLocation(program, "normal");
		var apClassification = gl.getAttribLocation(program, "classification");
		var apIndices = gl.getAttribLocation(program, "indices");

		gl.enableVertexAttribArray(apPosition);
		gl.enableVertexAttribArray(apColor);
		gl.enableVertexAttribArray(apNormal);
		gl.enableVertexAttribArray(apClassification);
		gl.enableVertexAttribArray(apIndices);
	}

	var nodes = pointcloud.visibleNodes;
	var _iteratorNormalCompletion = true;
	var _didIteratorError = false;
	var _iteratorError = undefined;

	try {
		for (var _iterator = nodes[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
			var node = _step.value;

			var object = node.sceneNode;
			var geometry = object.geometry;
		}
	} catch (err) {
		_didIteratorError = true;
		_iteratorError = err;
	} finally {
		try {
			if (!_iteratorNormalCompletion && _iterator.return) {
				_iterator.return();
			}
		} finally {
			if (_didIteratorError) {
				throw _iteratorError;
			}
		}
	}
};
"use strict";

Potree.PointCloudTreeNode = function () {

	this.getChildren = function () {
		throw "override function";
	};

	this.getBoundingBox = function () {
		throw "override function";
	};

	this.isLoaded = function () {
		throw "override function";
	};

	this.isGeometryNode = function () {
		throw "override function";
	};

	this.isTreeNode = function () {
		throw "override function";
	};

	this.getLevel = function () {
		throw "override function";
	};

	this.getBoundingSphere = function () {
		throw "override function";
	};
};

Potree.PointCloudTree = function () {
	THREE.Object3D.call(this);

	this.initialized = function () {
		return this.root !== null;
	};
};

Potree.PointCloudTree.prototype = Object.create(THREE.Object3D.prototype);
'use strict';

Potree.WorkerManager = function (code) {
	this.code = code;
	this.instances = [];
	this.createdInstances = 0;
};

Potree.WorkerManager.prototype.getWorker = function () {
	var ww = this.instances.pop();

	if (ww === undefined) {
		ww = Potree.utils.createWorker(this.code);
		this.createdInstances++;
	}

	return ww;
};

Potree.WorkerManager.prototype.returnWorker = function (worker) {
	this.instances.push(worker);
};

/**
 * urls point to WebWorker code.
 * Code must not contain calls to importScripts, 
 * concatenation is done by this method.
 * 
 */
Potree.WorkerManager.fromUrls = function (urls) {

	var code = "";
	for (var i = 0; i < urls.length; i++) {
		var url = urls[i];
		var xhr = new XMLHttpRequest();
		xhr.open('GET', url, false);
		xhr.responseType = 'text';
		xhr.overrideMimeType('text/plain; charset=x-user-defined');
		xhr.send(null);

		if (xhr.status === 200) {
			code += xhr.responseText + "\n";
		}
	}

	return new Potree.WorkerManager(code);
};
"use strict";

Potree.workers.binaryDecoder = new Potree.WorkerManager(atob("Ci8vIGh0dHA6Ly9qc3BlcmYuY29tL3VpbnQ4YXJyYXktdnMtZGF0YXZpZXczLzMKZnVuY3Rpb24gQ3VzdG9tVmlldyhidWZmZXIpIHsKCXRoaXMuYnVmZmVyID0gYnVmZmVyOwoJdGhpcy51OCA9IG5ldyBVaW50OEFycmF5KGJ1ZmZlcik7CgkKCXZhciB0bXAgPSBuZXcgQXJyYXlCdWZmZXIoNCk7Cgl2YXIgdG1wZiA9IG5ldyBGbG9hdDMyQXJyYXkodG1wKTsKCXZhciB0bXB1OCA9IG5ldyBVaW50OEFycmF5KHRtcCk7CgkKCXRoaXMuZ2V0VWludDMyID0gZnVuY3Rpb24gKGkpIHsKCQlyZXR1cm4gKHRoaXMudThbaSszXSA8PCAyNCkgfCAodGhpcy51OFtpKzJdIDw8IDE2KSB8ICh0aGlzLnU4W2krMV0gPDwgOCkgfCB0aGlzLnU4W2ldOwoJfTsKCQoJdGhpcy5nZXRVaW50MTYgPSBmdW5jdGlvbiAoaSkgewoJCXJldHVybiAodGhpcy51OFtpKzFdIDw8IDgpIHwgdGhpcy51OFtpXTsKCX07CgkKCXRoaXMuZ2V0RmxvYXQgPSBmdW5jdGlvbihpKXsKCQl0bXB1OFswXSA9IHRoaXMudThbaSswXTsKCQl0bXB1OFsxXSA9IHRoaXMudThbaSsxXTsKCQl0bXB1OFsyXSA9IHRoaXMudThbaSsyXTsKCQl0bXB1OFszXSA9IHRoaXMudThbaSszXTsKCQkKCQlyZXR1cm4gdG1wZlswXTsKCX07CgkKCXRoaXMuZ2V0VWludDggPSBmdW5jdGlvbihpKXsKCQlyZXR1cm4gdGhpcy51OFtpXTsKCX07Cn0KClBvdHJlZSA9IHt9OwoKCm9ubWVzc2FnZSA9IGZ1bmN0aW9uKGV2ZW50KXsKCXZhciBidWZmZXIgPSBldmVudC5kYXRhLmJ1ZmZlcjsKCXZhciBwb2ludEF0dHJpYnV0ZXMgPSBldmVudC5kYXRhLnBvaW50QXR0cmlidXRlczsKCXZhciBudW1Qb2ludHMgPSBidWZmZXIuYnl0ZUxlbmd0aCAvIHBvaW50QXR0cmlidXRlcy5ieXRlU2l6ZTsKCXZhciBjdiA9IG5ldyBDdXN0b21WaWV3KGJ1ZmZlcik7Cgl2YXIgdmVyc2lvbiA9IG5ldyBQb3RyZWUuVmVyc2lvbihldmVudC5kYXRhLnZlcnNpb24pOwoJdmFyIG1pbiA9IGV2ZW50LmRhdGEubWluOwoJdmFyIG5vZGVPZmZzZXQgPSBldmVudC5kYXRhLm9mZnNldDsKCXZhciBzY2FsZSA9IGV2ZW50LmRhdGEuc2NhbGU7Cgl2YXIgdGlnaHRCb3hNaW4gPSBbIE51bWJlci5QT1NJVElWRV9JTkZJTklUWSwgTnVtYmVyLlBPU0lUSVZFX0lORklOSVRZLCBOdW1iZXIuUE9TSVRJVkVfSU5GSU5JVFldOwoJdmFyIHRpZ2h0Qm94TWF4ID0gWyBOdW1iZXIuTkVHQVRJVkVfSU5GSU5JVFkgLCBOdW1iZXIuTkVHQVRJVkVfSU5GSU5JVFkgLCBOdW1iZXIuTkVHQVRJVkVfSU5GSU5JVFkgXTsKCQoJdmFyIGF0dHJpYnV0ZUJ1ZmZlcnMgPSB7fTsKCQoJdmFyIG9mZnNldCA9IDA7Cglmb3IodmFyIGkgPSAwOyBpIDwgcG9pbnRBdHRyaWJ1dGVzLmF0dHJpYnV0ZXMubGVuZ3RoOyBpKyspewoJCXZhciBwb2ludEF0dHJpYnV0ZSA9IHBvaW50QXR0cmlidXRlcy5hdHRyaWJ1dGVzW2ldOwoJCgkJaWYocG9pbnRBdHRyaWJ1dGUubmFtZSA9PT0gUG90cmVlLlBvaW50QXR0cmlidXRlLlBPU0lUSU9OX0NBUlRFU0lBTi5uYW1lKXsKCQkJCgkJCXZhciBidWZmID0gbmV3IEFycmF5QnVmZmVyKG51bVBvaW50cyo0KjMpOwoJCQl2YXIgcG9zaXRpb25zID0gbmV3IEZsb2F0MzJBcnJheShidWZmKTsKCQkJCgkJCWZvcih2YXIgaiA9IDA7IGogPCBudW1Qb2ludHM7IGorKyl7CgkJCQlpZih2ZXJzaW9uLm5ld2VyVGhhbigiMS4zIikpewoJCQkJCXBvc2l0aW9uc1szKmorMF0gPSAoY3YuZ2V0VWludDMyKG9mZnNldCArIGoqcG9pbnRBdHRyaWJ1dGVzLmJ5dGVTaXplKzApICogc2NhbGUpICsgbWluWzBdOwoJCQkJCXBvc2l0aW9uc1szKmorMV0gPSAoY3YuZ2V0VWludDMyKG9mZnNldCArIGoqcG9pbnRBdHRyaWJ1dGVzLmJ5dGVTaXplKzQpICogc2NhbGUpICsgbWluWzFdOwoJCQkJCXBvc2l0aW9uc1szKmorMl0gPSAoY3YuZ2V0VWludDMyKG9mZnNldCArIGoqcG9pbnRBdHRyaWJ1dGVzLmJ5dGVTaXplKzgpICogc2NhbGUpICsgbWluWzJdOwoJCQkJfWVsc2V7CgkJCQkJcG9zaXRpb25zWzMqaiswXSA9IGN2LmdldEZsb2F0KGoqcG9pbnRBdHRyaWJ1dGVzLmJ5dGVTaXplKzApICsgbm9kZU9mZnNldFswXTsKCQkJCQlwb3NpdGlvbnNbMypqKzFdID0gY3YuZ2V0RmxvYXQoaipwb2ludEF0dHJpYnV0ZXMuYnl0ZVNpemUrNCkgKyBub2RlT2Zmc2V0WzFdOwoJCQkJCXBvc2l0aW9uc1szKmorMl0gPSBjdi5nZXRGbG9hdChqKnBvaW50QXR0cmlidXRlcy5ieXRlU2l6ZSs4KSArIG5vZGVPZmZzZXRbMl07CgkJCQl9CgkJCQkKCQkJCXRpZ2h0Qm94TWluWzBdID0gTWF0aC5taW4odGlnaHRCb3hNaW5bMF0sIHBvc2l0aW9uc1szKmorMF0pOwoJCQkJdGlnaHRCb3hNaW5bMV0gPSBNYXRoLm1pbih0aWdodEJveE1pblsxXSwgcG9zaXRpb25zWzMqaisxXSk7CgkJCQl0aWdodEJveE1pblsyXSA9IE1hdGgubWluKHRpZ2h0Qm94TWluWzJdLCBwb3NpdGlvbnNbMypqKzJdKTsKCQkJCQoJCQkJdGlnaHRCb3hNYXhbMF0gPSBNYXRoLm1heCh0aWdodEJveE1heFswXSwgcG9zaXRpb25zWzMqaiswXSk7CgkJCQl0aWdodEJveE1heFsxXSA9IE1hdGgubWF4KHRpZ2h0Qm94TWF4WzFdLCBwb3NpdGlvbnNbMypqKzFdKTsKCQkJCXRpZ2h0Qm94TWF4WzJdID0gTWF0aC5tYXgodGlnaHRCb3hNYXhbMl0sIHBvc2l0aW9uc1szKmorMl0pOwoJCQl9CgkJCQoJCQlhdHRyaWJ1dGVCdWZmZXJzW3BvaW50QXR0cmlidXRlLm5hbWVdID0geyBidWZmZXI6IGJ1ZmYsIGF0dHJpYnV0ZTogcG9pbnRBdHRyaWJ1dGV9OwoJCQkKCQl9ZWxzZSBpZihwb2ludEF0dHJpYnV0ZS5uYW1lID09PSBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuQ09MT1JfUEFDS0VELm5hbWUpewoJCQkKCQkJdmFyIGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIobnVtUG9pbnRzKjMpOwoJCQl2YXIgY29sb3JzID0gbmV3IFVpbnQ4QXJyYXkoYnVmZik7CgkJCQoJCQlmb3IodmFyIGogPSAwOyBqIDwgbnVtUG9pbnRzOyBqKyspewoJCQkJY29sb3JzWzMqaiswXSA9IGN2LmdldFVpbnQ4KG9mZnNldCArIGoqcG9pbnRBdHRyaWJ1dGVzLmJ5dGVTaXplICsgMCk7CgkJCQljb2xvcnNbMypqKzFdID0gY3YuZ2V0VWludDgob2Zmc2V0ICsgaipwb2ludEF0dHJpYnV0ZXMuYnl0ZVNpemUgKyAxKTsKCQkJCWNvbG9yc1szKmorMl0gPSBjdi5nZXRVaW50OChvZmZzZXQgKyBqKnBvaW50QXR0cmlidXRlcy5ieXRlU2l6ZSArIDIpOwoJCQl9CgkJCQoJCQlhdHRyaWJ1dGVCdWZmZXJzW3BvaW50QXR0cmlidXRlLm5hbWVdID0geyBidWZmZXI6IGJ1ZmYsIGF0dHJpYnV0ZTogcG9pbnRBdHRyaWJ1dGV9OwoJCQkKCQl9ZWxzZSBpZihwb2ludEF0dHJpYnV0ZS5uYW1lID09PSBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuSU5URU5TSVRZLm5hbWUpewoKCQkJdmFyIGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIobnVtUG9pbnRzKjQpOwoJCQl2YXIgaW50ZW5zaXRpZXMgPSBuZXcgRmxvYXQzMkFycmF5KGJ1ZmYpOwoJCQkKCQkJZm9yKHZhciBqID0gMDsgaiA8IG51bVBvaW50czsgaisrKXsKCQkJCXZhciBpbnRlbnNpdHkgPSBjdi5nZXRVaW50MTYob2Zmc2V0ICsgaipwb2ludEF0dHJpYnV0ZXMuYnl0ZVNpemUpOwoJCQkJaW50ZW5zaXRpZXNbal0gPSBpbnRlbnNpdHk7CgkJCX0KCQkJCgkJCWF0dHJpYnV0ZUJ1ZmZlcnNbcG9pbnRBdHRyaWJ1dGUubmFtZV0gPSB7IGJ1ZmZlcjogYnVmZiwgYXR0cmlidXRlOiBwb2ludEF0dHJpYnV0ZX07CgkJCgkJfWVsc2UgaWYocG9pbnRBdHRyaWJ1dGUubmFtZSA9PT0gUG90cmVlLlBvaW50QXR0cmlidXRlLkNMQVNTSUZJQ0FUSU9OLm5hbWUpewoKCQkJdmFyIGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIobnVtUG9pbnRzKTsKCQkJdmFyIGNsYXNzaWZpY2F0aW9ucyA9IG5ldyBVaW50OEFycmF5KGJ1ZmYpOwoJCQkKCQkJZm9yKHZhciBqID0gMDsgaiA8IG51bVBvaW50czsgaisrKXsKCQkJCXZhciBjbGFzc2lmaWNhdGlvbiA9IGN2LmdldFVpbnQ4KG9mZnNldCArIGoqcG9pbnRBdHRyaWJ1dGVzLmJ5dGVTaXplKTsKCQkJCWNsYXNzaWZpY2F0aW9uc1tqXSA9IGNsYXNzaWZpY2F0aW9uOwoJCQl9CgkJCQoJCQlhdHRyaWJ1dGVCdWZmZXJzW3BvaW50QXR0cmlidXRlLm5hbWVdID0geyBidWZmZXI6IGJ1ZmYsIGF0dHJpYnV0ZTogcG9pbnRBdHRyaWJ1dGV9OwoJCQoJCX1lbHNlIGlmKHBvaW50QXR0cmlidXRlLm5hbWUgPT09IFBvdHJlZS5Qb2ludEF0dHJpYnV0ZS5OT1JNQUxfU1BIRVJFTUFQUEVELm5hbWUpewoKCQkJdmFyIGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIobnVtUG9pbnRzKjQqMyk7CgkJCXZhciBub3JtYWxzID0gbmV3IEZsb2F0MzJBcnJheShidWZmKTsKCQkJCgkJCWZvcih2YXIgaiA9IDA7IGogPCBudW1Qb2ludHM7IGorKyl7CgkJCQl2YXIgYnggPSBjdi5nZXRVaW50OChvZmZzZXQgKyBqICogcG9pbnRBdHRyaWJ1dGVzLmJ5dGVTaXplICsgMCk7CgkJCQl2YXIgYnkgPSBjdi5nZXRVaW50OChvZmZzZXQgKyBqICogcG9pbnRBdHRyaWJ1dGVzLmJ5dGVTaXplICsgMSk7CgkJCQoJCQkJdmFyIGV4ID0gYnggLyAyNTU7CgkJCQl2YXIgZXkgPSBieSAvIDI1NTsKCQkJCQoJCQkJdmFyIG54ID0gZXggKiAyIC0gMTsKCQkJCXZhciBueSA9IGV5ICogMiAtIDE7CgkJCQl2YXIgbnogPSAxOwoJCQkJdmFyIG53ID0gLTE7CgkJCQkKCQkJCXZhciBsID0gKG54ICogKC1ueCkpICsgKG55ICogKC1ueSkpICsgKG56ICogKC1udykpOwoJCQkJbnogPSBsOwoJCQkJbnggPSBueCAqIE1hdGguc3FydChsKTsKCQkJCW55ID0gbnkgKiBNYXRoLnNxcnQobCk7CgkJCQkKCQkJCW54ID0gbnggKiAyOwoJCQkJbnkgPSBueSAqIDI7CgkJCQlueiA9IG56ICogMiAtIDE7CgkJCQkKCQkJCW5vcm1hbHNbMypqICsgMF0gPSBueDsKCQkJCW5vcm1hbHNbMypqICsgMV0gPSBueTsKCQkJCW5vcm1hbHNbMypqICsgMl0gPSBuejsKCQkJfQoJCQkKCQkJYXR0cmlidXRlQnVmZmVyc1twb2ludEF0dHJpYnV0ZS5uYW1lXSA9IHsgYnVmZmVyOiBidWZmLCBhdHRyaWJ1dGU6IHBvaW50QXR0cmlidXRlfTsKCQl9ZWxzZSBpZihwb2ludEF0dHJpYnV0ZS5uYW1lID09PSBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuTk9STUFMX09DVDE2Lm5hbWUpewoJCQkKCQkJdmFyIGJ1ZmYgPSBuZXcgQXJyYXlCdWZmZXIobnVtUG9pbnRzKjQqMyk7CgkJCXZhciBub3JtYWxzID0gbmV3IEZsb2F0MzJBcnJheShidWZmKTsKCQkJZm9yKHZhciBqID0gMDsgaiA8IG51bVBvaW50czsgaisrKXsKCQkJCXZhciBieCA9IGN2LmdldFVpbnQ4KG9mZnNldCArIGogKiBwb2ludEF0dHJpYnV0ZXMuYnl0ZVNpemUgKyAwKTsKCQkJCXZhciBieSA9IGN2LmdldFVpbnQ4KG9mZnNldCArIGogKiBwb2ludEF0dHJpYnV0ZXMuYnl0ZVNpemUgKyAxKTsKCQkJCQoJCQkJdmFyIHUgPSAoYnggLyAyNTUpICogMiAtIDE7CgkJCQl2YXIgdiA9IChieSAvIDI1NSkgKiAyIC0gMTsKCQkJCQoJCQkJdmFyIHogPSAxIC0gTWF0aC5hYnModSkgLSBNYXRoLmFicyh2KTsKCQkJCQoJCQkJdmFyIHggPSAwOwoJCQkJdmFyIHkgPSAwOwoJCQkJaWYoeiA+PSAwKXsKCQkJCQl4ID0gdTsKCQkJCQl5ID0gdjsKCQkJCX1lbHNlewoJCQkJCXggPSAtICh2L01hdGguc2lnbih2KSAtIDEpIC8gTWF0aC5zaWduKHUpOwoJCQkJCXkgPSAtICh1L01hdGguc2lnbih1KSAtIDEpIC8gTWF0aC5zaWduKHYpOwoJCQkJfQoJCQkJCgkJCQl2YXIgbGVuZ3RoID0gTWF0aC5zcXJ0KHgqeCArIHkqeSArIHoqeik7CgkJCQl4ID0geCAvIGxlbmd0aDsKCQkJCXkgPSB5IC8gbGVuZ3RoOwoJCQkJeiA9IHogLyBsZW5ndGg7CgkJCQkKCQkJCW5vcm1hbHNbMypqICsgMF0gPSB4OwoJCQkJbm9ybWFsc1szKmogKyAxXSA9IHk7CgkJCQlub3JtYWxzWzMqaiArIDJdID0gejsKCQkJfQoJCQlhdHRyaWJ1dGVCdWZmZXJzW3BvaW50QXR0cmlidXRlLm5hbWVdID0geyBidWZmZXI6IGJ1ZmYsIGF0dHJpYnV0ZTogcG9pbnRBdHRyaWJ1dGV9OwoJCX1lbHNlIGlmKHBvaW50QXR0cmlidXRlLm5hbWUgPT09IFBvdHJlZS5Qb2ludEF0dHJpYnV0ZS5OT1JNQUwubmFtZSl7CgkJCgkJCXZhciBidWZmID0gbmV3IEFycmF5QnVmZmVyKG51bVBvaW50cyo0KjMpOwoJCQl2YXIgbm9ybWFscyA9IG5ldyBGbG9hdDMyQXJyYXkoYnVmZik7CgkJCWZvcih2YXIgaiA9IDA7IGogPCBudW1Qb2ludHM7IGorKyl7CgkJCQl2YXIgeCA9IGN2LmdldEZsb2F0KG9mZnNldCArIGogKiBwb2ludEF0dHJpYnV0ZXMuYnl0ZVNpemUgKyAwKTsKCQkJCXZhciB5ID0gY3YuZ2V0RmxvYXQob2Zmc2V0ICsgaiAqIHBvaW50QXR0cmlidXRlcy5ieXRlU2l6ZSArIDQpOwoJCQkJdmFyIHogPSBjdi5nZXRGbG9hdChvZmZzZXQgKyBqICogcG9pbnRBdHRyaWJ1dGVzLmJ5dGVTaXplICsgOCk7CgkJCQkKCQkJCW5vcm1hbHNbMypqICsgMF0gPSB4OwoJCQkJbm9ybWFsc1szKmogKyAxXSA9IHk7CgkJCQlub3JtYWxzWzMqaiArIDJdID0gejsKCQkJfQoJCQlhdHRyaWJ1dGVCdWZmZXJzW3BvaW50QXR0cmlidXRlLm5hbWVdID0geyBidWZmZXI6IGJ1ZmYsIGF0dHJpYnV0ZTogcG9pbnRBdHRyaWJ1dGV9OwoJCX0KCQkKCQlvZmZzZXQgKz0gcG9pbnRBdHRyaWJ1dGUuYnl0ZVNpemU7Cgl9CgkKCXZhciBpbmRpY2VzID0gbmV3IEFycmF5QnVmZmVyKG51bVBvaW50cyo0KTsKCXZhciBpSW5kaWNlcyA9IG5ldyBVaW50MzJBcnJheShpbmRpY2VzKTsKCWZvcih2YXIgaSA9IDA7IGkgPCBudW1Qb2ludHM7IGkrKyl7CgkJaUluZGljZXNbaV0gPSBpOwoJfQoJCglpZihhdHRyaWJ1dGVCdWZmZXJzW1BvdHJlZS5Qb2ludEF0dHJpYnV0ZS5DTEFTU0lGSUNBVElPTi5uYW1lXSA9PT0gdW5kZWZpbmVkKXsKCQl2YXIgYnVmZiA9IG5ldyBBcnJheUJ1ZmZlcihudW1Qb2ludHMqNCk7CgkJdmFyIGNsYXNzaWZpY2F0aW9ucyA9IG5ldyBGbG9hdDMyQXJyYXkoYnVmZik7CgkJCgkJZm9yKHZhciBqID0gMDsgaiA8IG51bVBvaW50czsgaisrKXsKCQkJY2xhc3NpZmljYXRpb25zW2pdID0gMDsKCQl9CgkJCgkJYXR0cmlidXRlQnVmZmVyc1tQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuQ0xBU1NJRklDQVRJT04ubmFtZV0gPSB7IGJ1ZmZlcjogYnVmZiwgYXR0cmlidXRlOiBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuQ0xBU1NJRklDQVRJT059OwoJfQoJCgkKCXZhciBtZXNzYWdlID0gewoJCWF0dHJpYnV0ZUJ1ZmZlcnM6IGF0dHJpYnV0ZUJ1ZmZlcnMsCgkJdGlnaHRCb3VuZGluZ0JveDogeyBtaW46IHRpZ2h0Qm94TWluLCBtYXg6IHRpZ2h0Qm94TWF4IH0sCgkJaW5kaWNlczogaW5kaWNlcwoJfTsKCQkKCXZhciB0cmFuc2ZlcmFibGVzID0gW107CgkKCWZvcih2YXIgcHJvcGVydHkgaW4gbWVzc2FnZS5hdHRyaWJ1dGVCdWZmZXJzKXsKCQlpZihtZXNzYWdlLmF0dHJpYnV0ZUJ1ZmZlcnMuaGFzT3duUHJvcGVydHkocHJvcGVydHkpKXsKCQkJdHJhbnNmZXJhYmxlcy5wdXNoKG1lc3NhZ2UuYXR0cmlidXRlQnVmZmVyc1twcm9wZXJ0eV0uYnVmZmVyKTsKCQl9Cgl9CgkKCXRyYW5zZmVyYWJsZXMucHVzaChtZXNzYWdlLmluZGljZXMpOwoJCQoJcG9zdE1lc3NhZ2UobWVzc2FnZSwgdHJhbnNmZXJhYmxlcyk7CgkKfTsKUG90cmVlLlZlcnNpb24gPSBmdW5jdGlvbih2ZXJzaW9uKXsKCXRoaXMudmVyc2lvbiA9IHZlcnNpb247Cgl2YXIgdm1MZW5ndGggPSAodmVyc2lvbi5pbmRleE9mKCIuIikgPT09IC0xKSA/IHZlcnNpb24ubGVuZ3RoIDogdmVyc2lvbi5pbmRleE9mKCIuIik7Cgl0aGlzLnZlcnNpb25NYWpvciA9IHBhcnNlSW50KHZlcnNpb24uc3Vic3RyKDAsIHZtTGVuZ3RoKSk7Cgl0aGlzLnZlcnNpb25NaW5vciA9IHBhcnNlSW50KHZlcnNpb24uc3Vic3RyKHZtTGVuZ3RoICsgMSkpOwoJaWYodGhpcy52ZXJzaW9uTWlub3IubGVuZ3RoID09PSAwKXsKCQl0aGlzLnZlcnNpb25NaW5vciA9IDA7Cgl9CgkKfTsKClBvdHJlZS5WZXJzaW9uLnByb3RvdHlwZS5uZXdlclRoYW4gPSBmdW5jdGlvbih2ZXJzaW9uKXsKCXZhciB2ID0gbmV3IFBvdHJlZS5WZXJzaW9uKHZlcnNpb24pOwoJCglpZiggdGhpcy52ZXJzaW9uTWFqb3IgPiB2LnZlcnNpb25NYWpvcil7CgkJcmV0dXJuIHRydWU7Cgl9ZWxzZSBpZiggdGhpcy52ZXJzaW9uTWFqb3IgPT09IHYudmVyc2lvbk1ham9yICYmIHRoaXMudmVyc2lvbk1pbm9yID4gdi52ZXJzaW9uTWlub3IpewoJCXJldHVybiB0cnVlOwoJfWVsc2V7CgkJcmV0dXJuIGZhbHNlOwoJfQp9OwoKUG90cmVlLlZlcnNpb24ucHJvdG90eXBlLmVxdWFsT3JIaWdoZXIgPSBmdW5jdGlvbih2ZXJzaW9uKXsKCXZhciB2ID0gbmV3IFBvdHJlZS5WZXJzaW9uKHZlcnNpb24pOwoJCglpZiggdGhpcy52ZXJzaW9uTWFqb3IgPiB2LnZlcnNpb25NYWpvcil7CgkJcmV0dXJuIHRydWU7Cgl9ZWxzZSBpZiggdGhpcy52ZXJzaW9uTWFqb3IgPT09IHYudmVyc2lvbk1ham9yICYmIHRoaXMudmVyc2lvbk1pbm9yID49IHYudmVyc2lvbk1pbm9yKXsKCQlyZXR1cm4gdHJ1ZTsKCX1lbHNlewoJCXJldHVybiBmYWxzZTsKCX0KfTsKClBvdHJlZS5WZXJzaW9uLnByb3RvdHlwZS51cFRvID0gZnVuY3Rpb24odmVyc2lvbil7CglyZXR1cm4gIXRoaXMubmV3ZXJUaGFuKHZlcnNpb24pOwp9OwpQb3RyZWUuUG9pbnRBdHRyaWJ1dGVOYW1lcyA9IHt9OwoKUG90cmVlLlBvaW50QXR0cmlidXRlTmFtZXMuUE9TSVRJT05fQ0FSVEVTSUFOIAk9IDA7CS8vIGZsb2F0IHgsIHksIHo7ClBvdHJlZS5Qb2ludEF0dHJpYnV0ZU5hbWVzLkNPTE9SX1BBQ0tFRAkJPSAxOwkvLyBieXRlIHIsIGcsIGIsIGE7IAlJID0gWzAsMV0KUG90cmVlLlBvaW50QXR0cmlidXRlTmFtZXMuQ09MT1JfRkxPQVRTXzEJCT0gMjsJLy8gZmxvYXQgciwgZywgYjsgCQlJID0gWzAsMV0KUG90cmVlLlBvaW50QXR0cmlidXRlTmFtZXMuQ09MT1JfRkxPQVRTXzI1NQk9IDM7CS8vIGZsb2F0IHIsIGcsIGI7IAkJSSA9IFswLDI1NV0KUG90cmVlLlBvaW50QXR0cmlidXRlTmFtZXMuTk9STUFMX0ZMT0FUUwkJPSA0OyAgCS8vIGZsb2F0IHgsIHksIHo7ClBvdHJlZS5Qb2ludEF0dHJpYnV0ZU5hbWVzLkZJTExFUgkJCQk9IDU7ClBvdHJlZS5Qb2ludEF0dHJpYnV0ZU5hbWVzLklOVEVOU0lUWQkJCT0gNjsKUG90cmVlLlBvaW50QXR0cmlidXRlTmFtZXMuQ0xBU1NJRklDQVRJT04JCT0gNzsKUG90cmVlLlBvaW50QXR0cmlidXRlTmFtZXMuTk9STUFMX1NQSEVSRU1BUFBFRAk9IDg7ClBvdHJlZS5Qb2ludEF0dHJpYnV0ZU5hbWVzLk5PUk1BTF9PQ1QxNgkJPSA5OwpQb3RyZWUuUG9pbnRBdHRyaWJ1dGVOYW1lcy5OT1JNQUwJCQkJPSAxMDsKCi8qKgogKiBTb21lIHR5cGVzIG9mIHBvc3NpYmxlIHBvaW50IGF0dHJpYnV0ZSBkYXRhIGZvcm1hdHMKICogCiAqIEBjbGFzcwogKi8KUG90cmVlLlBvaW50QXR0cmlidXRlVHlwZXMgPSB7CglEQVRBX1RZUEVfRE9VQkxFCToge29yZGluYWwgOiAwLCBzaXplOiA4fSwKCURBVEFfVFlQRV9GTE9BVAkJOiB7b3JkaW5hbCA6IDEsIHNpemU6IDR9LAoJREFUQV9UWVBFX0lOVDgJCToge29yZGluYWwgOiAyLCBzaXplOiAxfSwKCURBVEFfVFlQRV9VSU5UOAkJOiB7b3JkaW5hbCA6IDMsIHNpemU6IDF9LAoJREFUQV9UWVBFX0lOVDE2CQk6IHtvcmRpbmFsIDogNCwgc2l6ZTogMn0sCglEQVRBX1RZUEVfVUlOVDE2CToge29yZGluYWwgOiA1LCBzaXplOiAyfSwKCURBVEFfVFlQRV9JTlQzMgkJOiB7b3JkaW5hbCA6IDYsIHNpemU6IDR9LAoJREFUQV9UWVBFX1VJTlQzMgk6IHtvcmRpbmFsIDogNywgc2l6ZTogNH0sCglEQVRBX1RZUEVfSU5UNjQJCToge29yZGluYWwgOiA4LCBzaXplOiA4fSwKCURBVEFfVFlQRV9VSU5UNjQJOiB7b3JkaW5hbCA6IDksIHNpemU6IDh9Cn07Cgp2YXIgaSA9IDA7CmZvcih2YXIgb2JqIGluIFBvdHJlZS5Qb2ludEF0dHJpYnV0ZVR5cGVzKXsKCVBvdHJlZS5Qb2ludEF0dHJpYnV0ZVR5cGVzW2ldID0gUG90cmVlLlBvaW50QXR0cmlidXRlVHlwZXNbb2JqXTsKCWkrKzsKfQoKLyoqCiAqIEEgc2luZ2xlIHBvaW50IGF0dHJpYnV0ZSBzdWNoIGFzIGNvbG9yL25vcm1hbC8uLiBhbmQgaXRzIGRhdGEgZm9ybWF0L251bWJlciBvZiBlbGVtZW50cy8uLi4gCiAqIAogKiBAY2xhc3MKICogQHBhcmFtIG5hbWUgCiAqIEBwYXJhbSB0eXBlCiAqIEBwYXJhbSBzaXplCiAqIEByZXR1cm5zCiAqLwpQb3RyZWUuUG9pbnRBdHRyaWJ1dGUgPSBmdW5jdGlvbihuYW1lLCB0eXBlLCBudW1FbGVtZW50cyl7Cgl0aGlzLm5hbWUgPSBuYW1lOwoJdGhpcy50eXBlID0gdHlwZTsgCgl0aGlzLm51bUVsZW1lbnRzID0gbnVtRWxlbWVudHM7Cgl0aGlzLmJ5dGVTaXplID0gdGhpcy5udW1FbGVtZW50cyAqIHRoaXMudHlwZS5zaXplOwp9OwoKUG90cmVlLlBvaW50QXR0cmlidXRlLlBPU0lUSU9OX0NBUlRFU0lBTiA9IG5ldyBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUoCgkJUG90cmVlLlBvaW50QXR0cmlidXRlTmFtZXMuUE9TSVRJT05fQ0FSVEVTSUFOLAoJCVBvdHJlZS5Qb2ludEF0dHJpYnV0ZVR5cGVzLkRBVEFfVFlQRV9GTE9BVCwgMyk7CgpQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuUkdCQV9QQUNLRUQgPSBuZXcgUG90cmVlLlBvaW50QXR0cmlidXRlKAoJCVBvdHJlZS5Qb2ludEF0dHJpYnV0ZU5hbWVzLkNPTE9SX1BBQ0tFRCwKCQlQb3RyZWUuUG9pbnRBdHRyaWJ1dGVUeXBlcy5EQVRBX1RZUEVfSU5UOCwgNCk7CgpQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuQ09MT1JfUEFDS0VEID0gUG90cmVlLlBvaW50QXR0cmlidXRlLlJHQkFfUEFDS0VEOwoKUG90cmVlLlBvaW50QXR0cmlidXRlLlJHQl9QQUNLRUQgPSBuZXcgUG90cmVlLlBvaW50QXR0cmlidXRlKAoJCVBvdHJlZS5Qb2ludEF0dHJpYnV0ZU5hbWVzLkNPTE9SX1BBQ0tFRCwKCQlQb3RyZWUuUG9pbnRBdHRyaWJ1dGVUeXBlcy5EQVRBX1RZUEVfSU5UOCwgMyk7CgpQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuTk9STUFMX0ZMT0FUUyA9IG5ldyBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUoCgkJUG90cmVlLlBvaW50QXR0cmlidXRlTmFtZXMuTk9STUFMX0ZMT0FUUywKCQlQb3RyZWUuUG9pbnRBdHRyaWJ1dGVUeXBlcy5EQVRBX1RZUEVfRkxPQVQsIDMpOwoKUG90cmVlLlBvaW50QXR0cmlidXRlLkZJTExFUl8xQiA9IG5ldyBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUoCgkJUG90cmVlLlBvaW50QXR0cmlidXRlTmFtZXMuRklMTEVSLAoJCVBvdHJlZS5Qb2ludEF0dHJpYnV0ZVR5cGVzLkRBVEFfVFlQRV9VSU5UOCwgMSk7CgkJClBvdHJlZS5Qb2ludEF0dHJpYnV0ZS5JTlRFTlNJVFkgPSBuZXcgUG90cmVlLlBvaW50QXR0cmlidXRlKAoJCVBvdHJlZS5Qb2ludEF0dHJpYnV0ZU5hbWVzLklOVEVOU0lUWSwKCQlQb3RyZWUuUG9pbnRBdHRyaWJ1dGVUeXBlcy5EQVRBX1RZUEVfVUlOVDE2LCAxKTsJCQoJCQpQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuQ0xBU1NJRklDQVRJT04gPSBuZXcgUG90cmVlLlBvaW50QXR0cmlidXRlKAoJCVBvdHJlZS5Qb2ludEF0dHJpYnV0ZU5hbWVzLkNMQVNTSUZJQ0FUSU9OLAoJCVBvdHJlZS5Qb2ludEF0dHJpYnV0ZVR5cGVzLkRBVEFfVFlQRV9VSU5UOCwgMSk7CQoJCQpQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuTk9STUFMX1NQSEVSRU1BUFBFRCA9IG5ldyBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUoCgkJUG90cmVlLlBvaW50QXR0cmlidXRlTmFtZXMuTk9STUFMX1NQSEVSRU1BUFBFRCwKCQlQb3RyZWUuUG9pbnRBdHRyaWJ1dGVUeXBlcy5EQVRBX1RZUEVfVUlOVDgsIDIpOwkJCgkJClBvdHJlZS5Qb2ludEF0dHJpYnV0ZS5OT1JNQUxfT0NUMTYgPSBuZXcgUG90cmVlLlBvaW50QXR0cmlidXRlKAoJCVBvdHJlZS5Qb2ludEF0dHJpYnV0ZU5hbWVzLk5PUk1BTF9PQ1QxNiwKCQlQb3RyZWUuUG9pbnRBdHRyaWJ1dGVUeXBlcy5EQVRBX1RZUEVfVUlOVDgsIDIpOwkKCQkKUG90cmVlLlBvaW50QXR0cmlidXRlLk5PUk1BTCA9IG5ldyBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUoCgkJUG90cmVlLlBvaW50QXR0cmlidXRlTmFtZXMuTk9STUFMLAoJCVBvdHJlZS5Qb2ludEF0dHJpYnV0ZVR5cGVzLkRBVEFfVFlQRV9GTE9BVCwgMyk7CgovKioKICogT3JkZXJlZCBsaXN0IG9mIFBvaW50QXR0cmlidXRlcyB1c2VkIHRvIGlkZW50aWZ5IGhvdyBwb2ludHMgYXJlIGFsaWduZWQgaW4gYSBidWZmZXIuCiAqIAogKiBAY2xhc3MKICogCiAqLwpQb3RyZWUuUG9pbnRBdHRyaWJ1dGVzID0gZnVuY3Rpb24ocG9pbnRBdHRyaWJ1dGVzKXsKCXRoaXMuYXR0cmlidXRlcyA9IFtdOwoJdGhpcy5ieXRlU2l6ZSA9IDA7Cgl0aGlzLnNpemUgPSAwOwoJCglpZihwb2ludEF0dHJpYnV0ZXMgIT0gbnVsbCl7CQoJCWZvcih2YXIgaSA9IDA7IGkgPCBwb2ludEF0dHJpYnV0ZXMubGVuZ3RoOyBpKyspewoJCQl2YXIgcG9pbnRBdHRyaWJ1dGVOYW1lID0gcG9pbnRBdHRyaWJ1dGVzW2ldOwoJCQl2YXIgcG9pbnRBdHRyaWJ1dGUgPSBQb3RyZWUuUG9pbnRBdHRyaWJ1dGVbcG9pbnRBdHRyaWJ1dGVOYW1lXTsKCQkJdGhpcy5hdHRyaWJ1dGVzLnB1c2gocG9pbnRBdHRyaWJ1dGUpOwoJCQl0aGlzLmJ5dGVTaXplICs9IHBvaW50QXR0cmlidXRlLmJ5dGVTaXplOwoJCQl0aGlzLnNpemUrKzsKCQl9Cgl9Cn07CgpQb3RyZWUuUG9pbnRBdHRyaWJ1dGVzLnByb3RvdHlwZS5hZGQgPSBmdW5jdGlvbihwb2ludEF0dHJpYnV0ZSl7Cgl0aGlzLmF0dHJpYnV0ZXMucHVzaChwb2ludEF0dHJpYnV0ZSk7Cgl0aGlzLmJ5dGVTaXplICs9IHBvaW50QXR0cmlidXRlLmJ5dGVTaXplOwoJdGhpcy5zaXplKys7Cn07CgpQb3RyZWUuUG9pbnRBdHRyaWJ1dGVzLnByb3RvdHlwZS5oYXNDb2xvcnMgPSBmdW5jdGlvbigpewoJZm9yKHZhciBuYW1lIGluIHRoaXMuYXR0cmlidXRlcyl7CgkJdmFyIHBvaW50QXR0cmlidXRlID0gdGhpcy5hdHRyaWJ1dGVzW25hbWVdOwoJCWlmKHBvaW50QXR0cmlidXRlLm5hbWUgPT09IFBvdHJlZS5Qb2ludEF0dHJpYnV0ZU5hbWVzLkNPTE9SX1BBQ0tFRCl7CgkJCXJldHVybiB0cnVlOwoJCX0KCX0KCQoJcmV0dXJuIGZhbHNlOwp9OwoKUG90cmVlLlBvaW50QXR0cmlidXRlcy5wcm90b3R5cGUuaGFzTm9ybWFscyA9IGZ1bmN0aW9uKCl7Cglmb3IodmFyIG5hbWUgaW4gdGhpcy5hdHRyaWJ1dGVzKXsKCQl2YXIgcG9pbnRBdHRyaWJ1dGUgPSB0aGlzLmF0dHJpYnV0ZXNbbmFtZV07CgkJaWYoCgkJCXBvaW50QXR0cmlidXRlID09PSBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuTk9STUFMX1NQSEVSRU1BUFBFRCB8fCAKCQkJcG9pbnRBdHRyaWJ1dGUgPT09IFBvdHJlZS5Qb2ludEF0dHJpYnV0ZS5OT1JNQUxfRkxPQVRTIHx8CgkJCXBvaW50QXR0cmlidXRlID09PSBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuTk9STUFMIHx8CgkJCXBvaW50QXR0cmlidXRlID09PSBQb3RyZWUuUG9pbnRBdHRyaWJ1dGUuTk9STUFMX09DVDE2KXsKCQkJcmV0dXJuIHRydWU7CgkJfQoJfQoJCglyZXR1cm4gZmFsc2U7Cn07CgoK"));
"use strict";

Potree.Shaders["pointcloud.vs"] = ["", "precision mediump float;", "precision mediump int;", "", "", "", "", "#define max_clip_boxes 30", "", "attribute vec3 position;", "attribute vec3 color;", "attribute vec3 normal;", "attribute float intensity;", "attribute float classification;", "attribute float returnNumber;", "attribute float numberOfReturns;", "attribute float pointSourceID;", "attribute vec4 indices;", "", "uniform mat4 modelMatrix;", "uniform mat4 modelViewMatrix;", "uniform mat4 projectionMatrix;", "uniform mat4 viewMatrix;", "uniform mat3 normalMatrix;", "", "", "uniform float screenWidth;", "uniform float screenHeight;", "uniform float fov;", "uniform float spacing;", "uniform float near;", "uniform float far;", "", "#if defined use_clip_box", "	uniform mat4 clipBoxes[max_clip_boxes];", "	uniform vec3 clipBoxPositions[max_clip_boxes];", "#endif", "", "", "uniform float heightMin;", "uniform float heightMax;", "uniform float intensityMin;", "uniform float intensityMax;", "uniform float size;				// pixel size factor", "uniform float minSize;			// minimum pixel size", "uniform float maxSize;			// maximum pixel size", "uniform float octreeSize;", "uniform vec3 bbSize;", "uniform vec3 uColor;", "uniform float opacity;", "uniform float clipBoxCount;", "", "uniform vec2 intensityRange;", "uniform float intensityGamma;", "uniform float intensityContrast;", "uniform float intensityBrightness;", "uniform float rgbGamma;", "uniform float rgbContrast;", "uniform float rgbBrightness;", "uniform float transition;", "uniform float wRGB;", "uniform float wIntensity;", "uniform float wElevation;", "uniform float wClassification;", "uniform float wReturnNumber;", "uniform float wSourceID;", "", "", "uniform sampler2D visibleNodes;", "uniform sampler2D gradient;", "uniform sampler2D classificationLUT;", "uniform sampler2D depthMap;", "", "varying float	vOpacity;", "varying vec3	vColor;", "varying float	vLinearDepth;", "varying float	vLogDepth;", "varying vec3	vViewPosition;", "varying float 	vRadius;", "varying vec3	vWorldPosition;", "varying vec3	vNormal;", "", "", "// ---------------------", "// OCTREE", "// ---------------------", "", "#if (defined(adaptive_point_size) || defined(color_type_lod)) && defined(tree_type_octree)", "/**", " * number of 1-bits up to inclusive index position", " * number is treated as if it were an integer in the range 0-255", " *", " */", "float numberOfOnes(float number, float index){", "	float tmp = mod(number, pow(2.0, index + 1.0));", "	float numOnes = 0.0;", "	for(float i = 0.0; i < 8.0; i++){", "		if(mod(tmp, 2.0) != 0.0){", "			numOnes++;", "		}", "		tmp = floor(tmp / 2.0);", "	}", "	return numOnes;", "}", "", "", "/**", " * checks whether the bit at index is 1", " * number is treated as if it were an integer in the range 0-255", " *", " */", "bool isBitSet(float number, float index){", "	return mod(floor(number / pow(2.0, index)), 2.0) != 0.0;", "}", "", "", "/**", " * find the LOD at the point position", " */", "float getLOD(){", "	vec3 offset = vec3(0.0, 0.0, 0.0);", "	float iOffset = 0.0;", "	float depth = 0.0;", "	for(float i = 0.0; i <= 1000.0; i++){", "		float nodeSizeAtLevel = octreeSize  / pow(2.0, i);", "		vec3 index3d = (position - offset) / nodeSizeAtLevel;", "		index3d = floor(index3d + 0.5);", "		float index = 4.0*index3d.x + 2.0*index3d.y + index3d.z;", "		", "		vec4 value = texture2D(visibleNodes, vec2(iOffset / 2048.0, 0.0));", "		float mask = value.r * 255.0;", "		if(isBitSet(mask, index)){", "			// there are more visible child nodes at this position", "			iOffset = iOffset + value.g * 255.0 + numberOfOnes(mask, index - 1.0);", "			depth++;", "		}else{", "			// no more visible child nodes at this position", "			return depth;", "		}", "		offset = offset + (vec3(1.0, 1.0, 1.0) * nodeSizeAtLevel * 0.5) * index3d;", "	}", "		", "	return depth;", "}", "", "float getPointSizeAttenuation(){", "	return pow(1.9, getLOD());", "}", "", "", "#endif", "", "", "// ---------------------", "// KD-TREE", "// ---------------------", "", "#if (defined(adaptive_point_size) || defined(color_type_lod)) && defined(tree_type_kdtree)", "", "float getLOD(){", "	vec3 offset = vec3(0.0, 0.0, 0.0);", "	float iOffset = 0.0;", "	float depth = 0.0;", "		", "		", "	vec3 size = bbSize;	", "	vec3 pos = position;", "		", "	for(float i = 0.0; i <= 1000.0; i++){", "		", "		vec4 value = texture2D(visibleNodes, vec2(iOffset / 2048.0, 0.0));", "		", "		int children = int(value.r * 255.0);", "		float next = value.g * 255.0;", "		int split = int(value.b * 255.0);", "		", "		if(next == 0.0){", "		 	return depth;", "		}", "		", "		vec3 splitv = vec3(0.0, 0.0, 0.0);", "		if(split == 1){", "			splitv.x = 1.0;", "		}else if(split == 2){", "		 	splitv.y = 1.0;", "		}else if(split == 4){", "		 	splitv.z = 1.0;", "		}", "		", "		iOffset = iOffset + next;", "		", "		float factor = length(pos * splitv / size);", "		if(factor < 0.5){", "		 	// left", "		    if(children == 0 || children == 2){", "		    	return depth;", "		    }", "		}else{", "		  	// right", "		    pos = pos - size * splitv * 0.5;", "		    if(children == 0 || children == 1){", "		    	return depth;", "		    }", "		    if(children == 3){", "		    	iOffset = iOffset + 1.0;", "		    }", "		}", "		size = size * ((1.0 - (splitv + 1.0) / 2.0) + 0.5);", "		", "		depth++;", "	}", "		", "		", "	return depth;	", "}", "", "float getPointSizeAttenuation(){", "	return pow(1.3, getLOD());", "}", "", "#endif", "", "// formula adapted from: http://www.dfstudios.co.uk/articles/programming/image-programming-algorithms/image-processing-algorithms-part-5-contrast-adjustment/", "float getContrastFactor(float contrast){", "	return (1.0158730158730156 * (contrast + 1.0)) / (1.0158730158730156 - contrast);", "}", "", "vec3 getRGB(){", "	vec3 rgb = color;", "	", "	rgb = pow(rgb, vec3(rgbGamma));", "	rgb = rgb + rgbBrightness;", "	rgb = (rgb - 0.5) * getContrastFactor(rgbContrast) + 0.5;", "	rgb = clamp(rgb, 0.0, 1.0);", "	", "	return rgb;", "}", "", "float getIntensity(){", "	float w = (intensity - intensityRange.x) / (intensityRange.y - intensityRange.x);", "	w = pow(w, intensityGamma);", "	w = w + intensityBrightness;", "	w = (w - 0.5) * getContrastFactor(intensityContrast) + 0.5;", "	w = clamp(w, 0.0, 1.0);", "	", "	return w;", "}", "", "vec3 getElevation(){", "	vec4 world = modelMatrix * vec4( position, 1.0 );", "	float w = (world.z - heightMin) / (heightMax-heightMin);", "	vec3 cElevation = texture2D(gradient, vec2(w,1.0-w)).rgb;", "	", "	return cElevation;", "}", "", "vec4 getClassification(){", "	float c = mod(classification, 16.0);", "	vec2 uv = vec2(c / 255.0, 0.5);", "	vec4 classColor = texture2D(classificationLUT, uv);", "	", "	return classColor;", "}", "", "vec3 getReturnNumber(){", "	if(numberOfReturns == 1.0){", "		return vec3(1.0, 1.0, 0.0);", "	}else{", "		if(returnNumber == 1.0){", "			return vec3(1.0, 0.0, 0.0);", "		}else if(returnNumber == numberOfReturns){", "			return vec3(0.0, 0.0, 1.0);", "		}else{", "			return vec3(0.0, 1.0, 0.0);", "		}", "	}", "}", "", "vec3 getSourceID(){", "	float w = mod(pointSourceID, 10.0) / 10.0;", "	return texture2D(gradient, vec2(w,1.0 - w)).rgb;", "}", "", "vec3 getCompositeColor(){", "	vec3 c;", "	float w;", "", "	c += wRGB * getRGB();", "	w += wRGB;", "	", "	c += wIntensity * getIntensity() * vec3(1.0, 1.0, 1.0);", "	w += wIntensity;", "	", "	c += wElevation * getElevation();", "	w += wElevation;", "	", "	c += wReturnNumber * getReturnNumber();", "	w += wReturnNumber;", "	", "	c += wSourceID * getSourceID();", "	w += wSourceID;", "	", "	vec4 cl = wClassification * getClassification();", "    c += cl.a * cl.rgb;", "	w += wClassification * cl.a;", "", "	c = c / w;", "	", "	if(w == 0.0){", "		//c = color;", "		gl_Position = vec4(100.0, 100.0, 100.0, 0.0);", "	}", "	", "	return c;", "}", "", "void main() {", "	vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );", "	vViewPosition = mvPosition.xyz;", "	gl_Position = projectionMatrix * mvPosition;", "	vOpacity = opacity;", "	vLinearDepth = gl_Position.w;", "	vLogDepth = log2(gl_Position.w);", "	vNormal = normalize(normalMatrix * normal);", "", "	// ---------------------", "	// POINT COLOR", "	// ---------------------", "	vec4 cl = getClassification(); ", "	", "	#ifdef color_type_rgb", "		vColor = getRGB();", "	#elif defined color_type_height", "		vColor = getElevation();", "	#elif defined color_type_rgb_height", "		vec3 cHeight = getElevation();", "		vColor = (1.0 - transition) * getRGB() + transition * cHeight;", "	#elif defined color_type_depth", "		float linearDepth = -mvPosition.z ;", "		float expDepth = (gl_Position.z / gl_Position.w) * 0.5 + 0.5;", "		vColor = vec3(linearDepth, expDepth, 0.0);", "	#elif defined color_type_intensity", "		float w = getIntensity();", "		vColor = vec3(w, w, w);", "	#elif defined color_type_intensity_gradient", "		float w = getIntensity();", "		vColor = texture2D(gradient, vec2(w,1.0-w)).rgb;", "	#elif defined color_type_color", "		vColor = uColor;", "	#elif defined color_type_lod", "		float depth = getLOD();", "		float w = depth / 10.0;", "		vColor = texture2D(gradient, vec2(w,1.0-w)).rgb;", "	#elif defined color_type_point_index", "		vColor = indices.rgb;", "	#elif defined color_type_classification", "		vColor = cl.rgb;", "	#elif defined color_type_return_number", "		vColor = getReturnNumber();", "	#elif defined color_type_source", "		vColor = getSourceID();", "	#elif defined color_type_normal", "		vColor = (modelMatrix * vec4(normal, 0.0)).xyz;", "	#elif defined color_type_phong", "		vColor = color;", "	#elif defined color_type_composite", "		vColor = getCompositeColor();", "	#endif", "	", "	#if !defined color_type_composite", "		if(cl.a == 0.0){", "			gl_Position = vec4(100.0, 100.0, 100.0, 0.0);", "			", "			return;", "		}", "	#endif", "	", "	// ---------------------", "	// POINT SIZE", "	// ---------------------", "	float pointSize = 1.0;", "	", "	float slope = tan(fov / 2.0);", "	float projFactor =  -0.5 * screenHeight / (slope * vViewPosition.z);", "	", "	float r = spacing * 1.5;", "	vRadius = r;", "	#if defined fixed_point_size", "		pointSize = size;", "	#elif defined attenuated_point_size", "		pointSize = size * projFactor;", "	#elif defined adaptive_point_size", "		float worldSpaceSize = size * r / getPointSizeAttenuation();", "		pointSize = worldSpaceSize * projFactor;", "	#endif", "", "	pointSize = max(minSize, pointSize);", "	pointSize = min(maxSize, pointSize);", "	", "	vRadius = pointSize / projFactor;", "	", "	gl_PointSize = pointSize;", "	", "	", "	// ---------------------", "	// CLIPPING", "	// ---------------------", "	", "	#if defined use_clip_box", "		bool insideAny = false;", "		for(int i = 0; i < max_clip_boxes; i++){", "			if(i == int(clipBoxCount)){", "				break;", "			}", "		", "			vec4 clipPosition = clipBoxes[i] * modelMatrix * vec4( position, 1.0 );", "			bool inside = -0.5 <= clipPosition.x && clipPosition.x <= 0.5;", "			inside = inside && -0.5 <= clipPosition.y && clipPosition.y <= 0.5;", "			inside = inside && -0.5 <= clipPosition.z && clipPosition.z <= 0.5;", "			insideAny = insideAny || inside;", "		}", "		if(!insideAny){", "	", "			#if defined clip_outside", "				gl_Position = vec4(1000.0, 1000.0, 1000.0, 1.0);", "			#elif defined clip_highlight_inside && !defined(color_type_depth)", "				float c = (vColor.r + vColor.g + vColor.b) / 6.0;", "			#endif", "		}else{", "			#if defined clip_highlight_inside", "			vColor.r += 0.5;", "			#endif", "		}", "	", "	#endif", "	", "}", ""].join("\n");

Potree.Shaders["pointcloud.fs"] = ["", "precision mediump float;", "precision mediump int;", "", "#if defined use_interpolation", "	#extension GL_EXT_frag_depth : enable", "#endif", "", "uniform mat4 viewMatrix;", "uniform vec3 cameraPosition;", "", "", "uniform mat4 projectionMatrix;", "uniform float opacity;", "", "uniform float blendHardness;", "uniform float blendDepthSupplement;", "uniform float fov;", "uniform float spacing;", "uniform float near;", "uniform float far;", "uniform float pcIndex;", "uniform float screenWidth;", "uniform float screenHeight;", "", "uniform sampler2D depthMap;", "", "varying vec3	vColor;", "varying float	vOpacity;", "varying float	vLinearDepth;", "varying float	vLogDepth;", "varying vec3	vViewPosition;", "varying float	vRadius;", "varying vec3	vNormal;", "", "float specularStrength = 1.0;", "", "void main() {", "", "	vec3 color = vColor;", "	float depth = gl_FragCoord.z;", "", "	#if defined(circle_point_shape) || defined(use_interpolation) || defined (weighted_splats)", "		float u = 2.0 * gl_PointCoord.x - 1.0;", "		float v = 2.0 * gl_PointCoord.y - 1.0;", "	#endif", "	", "	#if defined(circle_point_shape) || defined (weighted_splats)", "		float cc = u*u + v*v;", "		if(cc > 1.0){", "			discard;", "		}", "	#endif", "	", "	#if defined weighted_splats", "		vec2 uv = gl_FragCoord.xy / vec2(screenWidth, screenHeight);", "		float sDepth = texture2D(depthMap, uv).r;", "		if(vLinearDepth > sDepth + vRadius + blendDepthSupplement){", "			discard;", "		}", "	#endif", "		", "	#if defined color_type_point_index", "		gl_FragColor = vec4(color, pcIndex / 255.0);", "	#else", "		gl_FragColor = vec4(color, vOpacity);", "	#endif", "", "	vec3 normal = normalize( vNormal );", "	normal.z = abs(normal.z);", "	vec3 viewPosition = normalize( vViewPosition );", "	", "	#if defined(color_type_phong)", "", "	// code taken from three.js phong light fragment shader", "	", "		#if MAX_POINT_LIGHTS > 0", "", "			vec3 pointDiffuse = vec3( 0.0 );", "			vec3 pointSpecular = vec3( 0.0 );", "", "			for ( int i = 0; i < MAX_POINT_LIGHTS; i ++ ) {", "", "				vec4 lPosition = viewMatrix * vec4( pointLightPosition[ i ], 1.0 );", "				vec3 lVector = lPosition.xyz + vViewPosition.xyz;", "", "				float lDistance = 1.0;", "				if ( pointLightDistance[ i ] > 0.0 )", "					lDistance = 1.0 - min( ( length( lVector ) / pointLightDistance[ i ] ), 1.0 );", "", "				lVector = normalize( lVector );", "", "						// diffuse", "", "				float dotProduct = dot( normal, lVector );", "", "				#ifdef WRAP_AROUND", "", "					float pointDiffuseWeightFull = max( dotProduct, 0.0 );", "					float pointDiffuseWeightHalf = max( 0.5 * dotProduct + 0.5, 0.0 );", "", "					vec3 pointDiffuseWeight = mix( vec3( pointDiffuseWeightFull ), vec3( pointDiffuseWeightHalf ), wrapRGB );", "", "				#else", "", "					float pointDiffuseWeight = max( dotProduct, 0.0 );", "", "				#endif", "", "				pointDiffuse += diffuse * pointLightColor[ i ] * pointDiffuseWeight * lDistance;", "", "						// specular", "", "				vec3 pointHalfVector = normalize( lVector + viewPosition );", "				float pointDotNormalHalf = max( dot( normal, pointHalfVector ), 0.0 );", "				float pointSpecularWeight = specularStrength * max( pow( pointDotNormalHalf, shininess ), 0.0 );", "", "				float specularNormalization = ( shininess + 2.0 ) / 8.0;", "", "				vec3 schlick = specular + vec3( 1.0 - specular ) * pow( max( 1.0 - dot( lVector, pointHalfVector ), 0.0 ), 5.0 );", "				pointSpecular += schlick * pointLightColor[ i ] * pointSpecularWeight * pointDiffuseWeight * lDistance * specularNormalization;", "				pointSpecular = vec3(0.0, 0.0, 0.0);", "			}", "		", "		#endif", "		", "		#if MAX_DIR_LIGHTS > 0", "", "			vec3 dirDiffuse = vec3( 0.0 );", "			vec3 dirSpecular = vec3( 0.0 );", "", "			for( int i = 0; i < MAX_DIR_LIGHTS; i ++ ) {", "", "				vec4 lDirection = viewMatrix * vec4( directionalLightDirection[ i ], 0.0 );", "				vec3 dirVector = normalize( lDirection.xyz );", "", "						// diffuse", "", "				float dotProduct = dot( normal, dirVector );", "", "				#ifdef WRAP_AROUND", "", "					float dirDiffuseWeightFull = max( dotProduct, 0.0 );", "					float dirDiffuseWeightHalf = max( 0.5 * dotProduct + 0.5, 0.0 );", "", "					vec3 dirDiffuseWeight = mix( vec3( dirDiffuseWeightFull ), vec3( dirDiffuseWeightHalf ), wrapRGB );", "", "				#else", "", "					float dirDiffuseWeight = max( dotProduct, 0.0 );", "", "				#endif", "", "				dirDiffuse += diffuse * directionalLightColor[ i ] * dirDiffuseWeight;", "", "				// specular", "", "				vec3 dirHalfVector = normalize( dirVector + viewPosition );", "				float dirDotNormalHalf = max( dot( normal, dirHalfVector ), 0.0 );", "				float dirSpecularWeight = specularStrength * max( pow( dirDotNormalHalf, shininess ), 0.0 );", "", "				float specularNormalization = ( shininess + 2.0 ) / 8.0;", "", "				vec3 schlick = specular + vec3( 1.0 - specular ) * pow( max( 1.0 - dot( dirVector, dirHalfVector ), 0.0 ), 5.0 );", "				dirSpecular += schlick * directionalLightColor[ i ] * dirSpecularWeight * dirDiffuseWeight * specularNormalization;", "			}", "", "		#endif", "		", "		vec3 totalDiffuse = vec3( 0.0 );", "		vec3 totalSpecular = vec3( 0.0 );", "		", "		#if MAX_POINT_LIGHTS > 0", "", "			totalDiffuse += pointDiffuse;", "			totalSpecular += pointSpecular;", "", "		#endif", "		", "		#if MAX_DIR_LIGHTS > 0", "", "			totalDiffuse += dirDiffuse;", "			totalSpecular += dirSpecular;", "", "		#endif", "		", "		gl_FragColor.xyz = gl_FragColor.xyz * ( emissive + totalDiffuse + ambientLightColor * ambient ) + totalSpecular;", "", "	#endif", "	", "	#if defined weighted_splats", "	    //float w = pow(1.0 - (u*u + v*v), blendHardness);", "		", "		float wx = 2.0 * length(2.0 * gl_PointCoord - 1.0);", "		float w = exp(-wx * wx * 0.5);", "		", "		//float distance = length(2.0 * gl_PointCoord - 1.0);", "		//float w = exp( -(distance * distance) / blendHardness);", "		", "		gl_FragColor.rgb = gl_FragColor.rgb * w;", "		gl_FragColor.a = w;", "	#endif", "	", "	#if defined use_interpolation", "		float wi = 0.0 - ( u*u + v*v);", "		vec4 pos = vec4(vViewPosition, 1.0);", "		pos.z += wi * vRadius;", "		float linearDepth = -pos.z;", "		pos = projectionMatrix * pos;", "		pos = pos / pos.w;", "		float expDepth = pos.z;", "		depth = (pos.z + 1.0) / 2.0;", "		gl_FragDepthEXT = depth;", "		", "		#if defined(color_type_depth)", "			color.r = linearDepth;", "			color.g = expDepth;", "		#endif", "		", "		#if defined(use_edl)", "			gl_FragColor.a = log2(linearDepth);", "		#endif", "		", "	#else", "		#if defined(use_edl)", "			gl_FragColor.a = vLogDepth;", "		#endif", "	#endif", "	", "	", "		", "	", "	", "	", "	", "}", "", "", ""].join("\n");

Potree.Shaders["normalize.vs"] = ["", "varying vec2 vUv;", "", "void main() {", "    vUv = uv;", "", "    gl_Position =   projectionMatrix * modelViewMatrix * vec4(position,1.0);", "}"].join("\n");

Potree.Shaders["normalize.fs"] = ["", "#extension GL_EXT_frag_depth : enable", "", "uniform sampler2D depthMap;", "uniform sampler2D texture;", "", "varying vec2 vUv;", "", "void main() {", "    float depth = texture2D(depthMap, vUv).g; ", "	", "	if(depth <= 0.0){", "		discard;", "	}", "	", "    vec4 color = texture2D(texture, vUv); ", "	color = color / color.w;", "    ", "	gl_FragColor = vec4(color.xyz, 1.0); ", "	", "	gl_FragDepthEXT = depth;", "}"].join("\n");

Potree.Shaders["edl.vs"] = ["", "", "varying vec2 vUv;", "", "void main() {", "    vUv = uv;", "	", "	vec4 mvPosition = modelViewMatrix * vec4(position,1.0);", "", "    gl_Position = projectionMatrix * mvPosition;", "}"].join("\n");

Potree.Shaders["edl.fs"] = ["// ", "// adapted from the EDL shader code from Christian Boucheny in cloud compare:", "// https://github.com/cloudcompare/trunk/tree/master/plugins/qEDL/shaders/EDL", "//", "", "//#define NEIGHBOUR_COUNT 4", "", "uniform float screenWidth;", "uniform float screenHeight;", "uniform vec2 neighbours[NEIGHBOUR_COUNT];", "uniform float edlStrength;", "uniform float radius;", "uniform float opacity;", "", "uniform sampler2D colorMap;", "", "varying vec2 vUv;", "", "const float infinity = 1.0 / 0.0;", "", "float response(float depth){", "	vec2 uvRadius = radius / vec2(screenWidth, screenHeight);", "	", "	float sum = 0.0;", "	", "	for(int i = 0; i < NEIGHBOUR_COUNT; i++){", "		vec2 uvNeighbor = vUv + uvRadius * neighbours[i];", "		", "		float neighbourDepth = texture2D(colorMap, uvNeighbor).a;", "		", "		if(neighbourDepth == 0.0){", "			neighbourDepth = infinity;", "		}", "		", "		sum += max(0.0, depth - neighbourDepth);", "	}", "	", "	return sum / float(NEIGHBOUR_COUNT);", "}", "", "void main(){", "	vec4 color = texture2D(colorMap, vUv);", "	", "	float depth = color.a;", "	if(depth == 0.0){", "		depth = infinity;", "	}", "	", "	float res = response(depth);", "	float shade = exp(-res * 300.0 * edlStrength);", "	", "	if(color.a == 0.0 && res == 0.0){", "		discard;", "	}", "	", "	gl_FragColor = vec4(color.rgb * shade, opacity);", "}", ""].join("\n");

Potree.Shaders["blur.vs"] = ["", "varying vec2 vUv;", "", "void main() {", "    vUv = uv;", "", "    gl_Position =   projectionMatrix * modelViewMatrix * vec4(position,1.0);", "}"].join("\n");

Potree.Shaders["blur.fs"] = ["", "uniform mat4 projectionMatrix;", "", "uniform float screenWidth;", "uniform float screenHeight;", "uniform float near;", "uniform float far;", "", "uniform sampler2D map;", "", "varying vec2 vUv;", "", "void main() {", "", "	float dx = 1.0 / screenWidth;", "	float dy = 1.0 / screenHeight;", "", "	vec3 color = vec3(0.0, 0.0, 0.0);", "	color += texture2D(map, vUv + vec2(-dx, -dy)).rgb;", "	color += texture2D(map, vUv + vec2(  0, -dy)).rgb;", "	color += texture2D(map, vUv + vec2(+dx, -dy)).rgb;", "	color += texture2D(map, vUv + vec2(-dx,   0)).rgb;", "	color += texture2D(map, vUv + vec2(  0,   0)).rgb;", "	color += texture2D(map, vUv + vec2(+dx,   0)).rgb;", "	color += texture2D(map, vUv + vec2(-dx,  dy)).rgb;", "	color += texture2D(map, vUv + vec2(  0,  dy)).rgb;", "	color += texture2D(map, vUv + vec2(+dx,  dy)).rgb;", "    ", "	color = color / 9.0;", "	", "	gl_FragColor = vec4(color, 1.0);", "	", "	", "}"].join("\n");
"use strict";

THREE.PerspectiveCamera.prototype.zoomTo = function (node, factor) {

	if (!node.geometry && !node.boundingSphere && !node.boundingBox) {
		return;
	}

	if (node.geometry && node.geometry.boundingSphere === null) {
		node.geometry.computeBoundingSphere();
	}

	node.updateMatrixWorld();

	var bs;

	if (node.boundingSphere) {
		bs = node.boundingSphere;
	} else if (node.geometry && node.geometry.boundingSphere) {
		bs = node.geometry.boundingSphere;
	} else {
		bs = node.boundingBox.getBoundingSphere();
	}

	var _factor = factor || 1;

	bs = bs.clone().applyMatrix4(node.matrixWorld);
	var radius = bs.radius;
	var fovr = this.fov * Math.PI / 180;

	if (this.aspect < 1) {
		fovr = fovr * this.aspect;
	}

	var distanceFactor = Math.abs(radius / Math.sin(fovr / 2)) * _factor;

	var offset = this.getWorldDirection().multiplyScalar(-distanceFactor);
	this.position.copy(bs.center.clone().add(offset));
};

//THREE.PerspectiveCamera.prototype.zoomTo = function(node, factor){
//	if(factor === undefined){
//		factor = 1;
//	}
//
//	node.updateMatrixWorld();
//	this.updateMatrix();
//	this.updateMatrixWorld();
//	
//	var box = Potree.utils.computeTransformedBoundingBox(node.boundingBox, node.matrixWorld);
//	var dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.quaternion);
//	var pos = box.center().sub(dir);
//	
//	var ps = [
//		new THREE.Vector3(box.min.x, box.min.y, box.min.z),
//		new THREE.Vector3(box.min.x, box.min.y, box.min.z),
//		new THREE.Vector3(box.max.x, box.min.y, box.min.z),
//		new THREE.Vector3(box.min.x, box.max.y, box.min.z),
//		new THREE.Vector3(box.min.x, box.min.y, box.max.z),
//		new THREE.Vector3(box.min.x, box.max.y, box.max.z),
//		new THREE.Vector3(box.max.x, box.max.y, box.min.z),
//		new THREE.Vector3(box.max.x, box.min.y, box.max.z),
//		new THREE.Vector3(box.max.x, box.max.y, box.max.z)
//	];
//	
//	var frustum = new THREE.Frustum();
//	frustum.setFromMatrix(new THREE.Matrix4().multiplyMatrices(this.projectionMatrix, this.matrixWorldInverse));
//	
//	var max = Number.MIN_VALUE;
//	for(var i = 0; i < ps.length; i++){
//		var p  = ps[i];
//		
//		var distance = Number.MIN_VALUE;
//		// iterate through left, right, top and bottom planes
//		for(var j = 0; j < frustum.planes.length-2; j++){
//			var plane = frustum.planes[j];
//			var ray = new THREE.Ray(p, dir);
//			var dI = ray.distanceToPlaneWithNegative(plane);
//			distance = Math.max(distance, dI);
//		}
//		max = Math.max(max, distance);
//	}
//	var offset = dir.clone().multiplyScalar(-max);
//	offset.multiplyScalar(factor);
//	pos.add(offset);
//	this.position.copy(pos);
//	
//}
"use strict";

THREE.Ray.prototype.distanceToPlaneWithNegative = function (plane) {
	var denominator = plane.normal.dot(this.direction);
	if (denominator === 0) {

		// line is coplanar, return origin
		if (plane.distanceToPoint(this.origin) === 0) {
			return 0;
		}

		// Null is preferable to undefined since undefined means.... it is undefined
		return null;
	}
	var t = -(this.origin.dot(plane.normal) + plane.constant) / denominator;

	return t;
};
"use strict";

/**
 * @class Loads mno files and returns a PointcloudOctree
 * for a description of the mno binary file format, read mnoFileFormat.txt
 * 
 * @author Markus Schuetz
 */
Potree.POCLoader = function () {};

/**
 * @return a point cloud octree with the root node data loaded. 
 * loading of descendants happens asynchronously when they're needed
 * 
 * @param url
 * @param loadingFinishedListener executed after loading the binary has been finished
 */
Potree.POCLoader.load = function load(url, callback) {
	try {
		var pco = new Potree.PointCloudOctreeGeometry();
		pco.url = url;
		var xhr = new XMLHttpRequest();
		xhr.open('GET', url, true);

		xhr.onreadystatechange = function () {
			if (xhr.readyState === 4 && (xhr.status === 200 || xhr.status === 0)) {
				var fMno = JSON.parse(xhr.responseText);

				var version = new Potree.Version(fMno.version);

				// assume octreeDir is absolute if it starts with http
				if (fMno.octreeDir.indexOf("http") === 0) {
					pco.octreeDir = fMno.octreeDir;
				} else {
					pco.octreeDir = url + "/../" + fMno.octreeDir;
				}

				pco.spacing = fMno.spacing;
				pco.hierarchyStepSize = fMno.hierarchyStepSize;

				pco.pointAttributes = fMno.pointAttributes;

				var min = new THREE.Vector3(fMno.boundingBox.lx, fMno.boundingBox.ly, fMno.boundingBox.lz);
				var max = new THREE.Vector3(fMno.boundingBox.ux, fMno.boundingBox.uy, fMno.boundingBox.uz);
				var boundingBox = new THREE.Box3(min, max);
				var tightBoundingBox = boundingBox.clone();

				if (fMno.tightBoundingBox) {
					tightBoundingBox.min.copy(new THREE.Vector3(fMno.tightBoundingBox.lx, fMno.tightBoundingBox.ly, fMno.tightBoundingBox.lz));
					tightBoundingBox.max.copy(new THREE.Vector3(fMno.tightBoundingBox.ux, fMno.tightBoundingBox.uy, fMno.tightBoundingBox.uz));
				}

				var offset = new THREE.Vector3(0, 0, 0);

				offset.set(-min.x, -min.y, -min.z);

				// for precision problem presentation purposes
				//offset.set(50000*1000,0,0);

				boundingBox.min.add(offset);
				boundingBox.max.add(offset);

				tightBoundingBox.min.add(offset);
				tightBoundingBox.max.add(offset);

				pco.projection = fMno.projection;
				pco.boundingBox = boundingBox;
				pco.tightBoundingBox = tightBoundingBox;
				pco.boundingSphere = boundingBox.getBoundingSphere();
				pco.tightBoundingSphere = tightBoundingBox.getBoundingSphere();
				pco.offset = offset;
				if (fMno.pointAttributes === "LAS") {
					pco.loader = new Potree.LasLazLoader(fMno.version);
				} else if (fMno.pointAttributes === "LAZ") {
					pco.loader = new Potree.LasLazLoader(fMno.version);
				} else {
					pco.loader = new Potree.BinaryLoader(fMno.version, boundingBox, fMno.scale);
					pco.pointAttributes = new Potree.PointAttributes(pco.pointAttributes);
				}

				var nodes = {};

				{
					// load root
					var name = "r";

					var root = new Potree.PointCloudOctreeGeometryNode(name, pco, boundingBox);
					root.level = 0;
					root.hasChildren = true;
					if (version.upTo("1.5")) {
						root.numPoints = fMno.hierarchy[0][1];
					} else {
						root.numPoints = 0;
					}
					pco.root = root;
					pco.root.load();
					nodes[name] = root;
				}

				// load remaining hierarchy
				if (version.upTo("1.4")) {
					for (var i = 1; i < fMno.hierarchy.length; i++) {
						var name = fMno.hierarchy[i][0];
						var numPoints = fMno.hierarchy[i][1];
						var index = parseInt(name.charAt(name.length - 1));
						var parentName = name.substring(0, name.length - 1);
						var parentNode = nodes[parentName];
						var level = name.length - 1;
						var boundingBox = Potree.POCLoader.createChildAABB(parentNode.boundingBox, index);

						var node = new Potree.PointCloudOctreeGeometryNode(name, pco, boundingBox);
						node.level = level;
						node.numPoints = numPoints;
						parentNode.addChild(node);
						nodes[name] = node;
					}
				}

				pco.nodes = nodes;

				callback(pco);
			}
		};

		xhr.send(null);
	} catch (e) {
		console.log("loading failed: '" + url + "'");
		console.log(e);

		callback();
	}
};

Potree.POCLoader.loadPointAttributes = function (mno) {

	var fpa = mno.pointAttributes;
	var pa = new Potree.PointAttributes();

	for (var i = 0; i < fpa.length; i++) {
		var pointAttribute = Potree.PointAttribute[fpa[i]];
		pa.add(pointAttribute);
	}

	return pa;
};

Potree.POCLoader.createChildAABB = function (aabb, childIndex) {
	var V3 = THREE.Vector3;
	var min = aabb.min;
	var max = aabb.max;
	var dHalfLength = new THREE.Vector3().copy(max).sub(min).multiplyScalar(0.5);
	var xHalfLength = new THREE.Vector3(dHalfLength.x, 0, 0);
	var yHalfLength = new THREE.Vector3(0, dHalfLength.y, 0);
	var zHalfLength = new THREE.Vector3(0, 0, dHalfLength.z);

	var cmin = min;
	var cmax = new THREE.Vector3().add(min).add(dHalfLength);

	var min, max;
	if (childIndex === 1) {
		min = new THREE.Vector3().copy(cmin).add(zHalfLength);
		max = new THREE.Vector3().copy(cmax).add(zHalfLength);
	} else if (childIndex === 3) {
		min = new THREE.Vector3().copy(cmin).add(zHalfLength).add(yHalfLength);
		max = new THREE.Vector3().copy(cmax).add(zHalfLength).add(yHalfLength);
	} else if (childIndex === 0) {
		min = cmin;
		max = cmax;
	} else if (childIndex === 2) {
		min = new THREE.Vector3().copy(cmin).add(yHalfLength);
		max = new THREE.Vector3().copy(cmax).add(yHalfLength);
	} else if (childIndex === 5) {
		min = new THREE.Vector3().copy(cmin).add(zHalfLength).add(xHalfLength);
		max = new THREE.Vector3().copy(cmax).add(zHalfLength).add(xHalfLength);
	} else if (childIndex === 7) {
		min = new THREE.Vector3().copy(cmin).add(dHalfLength);
		max = new THREE.Vector3().copy(cmax).add(dHalfLength);
	} else if (childIndex === 4) {
		min = new THREE.Vector3().copy(cmin).add(xHalfLength);
		max = new THREE.Vector3().copy(cmax).add(xHalfLength);
	} else if (childIndex === 6) {
		min = new THREE.Vector3().copy(cmin).add(xHalfLength).add(yHalfLength);
		max = new THREE.Vector3().copy(cmax).add(xHalfLength).add(yHalfLength);
	}

	return new THREE.Box3(min, max);
};
"use strict";

Potree.PointAttributeNames = {};

Potree.PointAttributeNames.POSITION_CARTESIAN = 0; // float x, y, z;
Potree.PointAttributeNames.COLOR_PACKED = 1; // byte r, g, b, a; 	I = [0,1]
Potree.PointAttributeNames.COLOR_FLOATS_1 = 2; // float r, g, b; 		I = [0,1]
Potree.PointAttributeNames.COLOR_FLOATS_255 = 3; // float r, g, b; 		I = [0,255]
Potree.PointAttributeNames.NORMAL_FLOATS = 4; // float x, y, z;
Potree.PointAttributeNames.FILLER = 5;
Potree.PointAttributeNames.INTENSITY = 6;
Potree.PointAttributeNames.CLASSIFICATION = 7;
Potree.PointAttributeNames.NORMAL_SPHEREMAPPED = 8;
Potree.PointAttributeNames.NORMAL_OCT16 = 9;
Potree.PointAttributeNames.NORMAL = 10;

/**
 * Some types of possible point attribute data formats
 * 
 * @class
 */
Potree.PointAttributeTypes = {
	DATA_TYPE_DOUBLE: { ordinal: 0, size: 8 },
	DATA_TYPE_FLOAT: { ordinal: 1, size: 4 },
	DATA_TYPE_INT8: { ordinal: 2, size: 1 },
	DATA_TYPE_UINT8: { ordinal: 3, size: 1 },
	DATA_TYPE_INT16: { ordinal: 4, size: 2 },
	DATA_TYPE_UINT16: { ordinal: 5, size: 2 },
	DATA_TYPE_INT32: { ordinal: 6, size: 4 },
	DATA_TYPE_UINT32: { ordinal: 7, size: 4 },
	DATA_TYPE_INT64: { ordinal: 8, size: 8 },
	DATA_TYPE_UINT64: { ordinal: 9, size: 8 }
};

var i = 0;
for (var obj in Potree.PointAttributeTypes) {
	Potree.PointAttributeTypes[i] = Potree.PointAttributeTypes[obj];
	i++;
}

/**
 * A single point attribute such as color/normal/.. and its data format/number of elements/... 
 * 
 * @class
 * @param name 
 * @param type
 * @param size
 * @returns
 */
Potree.PointAttribute = function (name, type, numElements) {
	this.name = name;
	this.type = type;
	this.numElements = numElements;
	this.byteSize = this.numElements * this.type.size;
};

Potree.PointAttribute.POSITION_CARTESIAN = new Potree.PointAttribute(Potree.PointAttributeNames.POSITION_CARTESIAN, Potree.PointAttributeTypes.DATA_TYPE_FLOAT, 3);

Potree.PointAttribute.RGBA_PACKED = new Potree.PointAttribute(Potree.PointAttributeNames.COLOR_PACKED, Potree.PointAttributeTypes.DATA_TYPE_INT8, 4);

Potree.PointAttribute.COLOR_PACKED = Potree.PointAttribute.RGBA_PACKED;

Potree.PointAttribute.RGB_PACKED = new Potree.PointAttribute(Potree.PointAttributeNames.COLOR_PACKED, Potree.PointAttributeTypes.DATA_TYPE_INT8, 3);

Potree.PointAttribute.NORMAL_FLOATS = new Potree.PointAttribute(Potree.PointAttributeNames.NORMAL_FLOATS, Potree.PointAttributeTypes.DATA_TYPE_FLOAT, 3);

Potree.PointAttribute.FILLER_1B = new Potree.PointAttribute(Potree.PointAttributeNames.FILLER, Potree.PointAttributeTypes.DATA_TYPE_UINT8, 1);

Potree.PointAttribute.INTENSITY = new Potree.PointAttribute(Potree.PointAttributeNames.INTENSITY, Potree.PointAttributeTypes.DATA_TYPE_UINT16, 1);

Potree.PointAttribute.CLASSIFICATION = new Potree.PointAttribute(Potree.PointAttributeNames.CLASSIFICATION, Potree.PointAttributeTypes.DATA_TYPE_UINT8, 1);

Potree.PointAttribute.NORMAL_SPHEREMAPPED = new Potree.PointAttribute(Potree.PointAttributeNames.NORMAL_SPHEREMAPPED, Potree.PointAttributeTypes.DATA_TYPE_UINT8, 2);

Potree.PointAttribute.NORMAL_OCT16 = new Potree.PointAttribute(Potree.PointAttributeNames.NORMAL_OCT16, Potree.PointAttributeTypes.DATA_TYPE_UINT8, 2);

Potree.PointAttribute.NORMAL = new Potree.PointAttribute(Potree.PointAttributeNames.NORMAL, Potree.PointAttributeTypes.DATA_TYPE_FLOAT, 3);

/**
 * Ordered list of PointAttributes used to identify how points are aligned in a buffer.
 * 
 * @class
 * 
 */
Potree.PointAttributes = function (pointAttributes) {
	this.attributes = [];
	this.byteSize = 0;
	this.size = 0;

	if (pointAttributes != null) {
		for (var i = 0; i < pointAttributes.length; i++) {
			var pointAttributeName = pointAttributes[i];
			var pointAttribute = Potree.PointAttribute[pointAttributeName];
			this.attributes.push(pointAttribute);
			this.byteSize += pointAttribute.byteSize;
			this.size++;
		}
	}
};

Potree.PointAttributes.prototype.add = function (pointAttribute) {
	this.attributes.push(pointAttribute);
	this.byteSize += pointAttribute.byteSize;
	this.size++;
};

Potree.PointAttributes.prototype.hasColors = function () {
	for (var name in this.attributes) {
		var pointAttribute = this.attributes[name];
		if (pointAttribute.name === Potree.PointAttributeNames.COLOR_PACKED) {
			return true;
		}
	}

	return false;
};

Potree.PointAttributes.prototype.hasNormals = function () {
	for (var name in this.attributes) {
		var pointAttribute = this.attributes[name];
		if (pointAttribute === Potree.PointAttribute.NORMAL_SPHEREMAPPED || pointAttribute === Potree.PointAttribute.NORMAL_FLOATS || pointAttribute === Potree.PointAttribute.NORMAL || pointAttribute === Potree.PointAttribute.NORMAL_OCT16) {
			return true;
		}
	}

	return false;
};
"use strict";

Potree.BinaryLoader = function (version, boundingBox, scale) {
	if (typeof version === "string") {
		this.version = new Potree.Version(version);
	} else {
		this.version = version;
	}

	this.boundingBox = boundingBox;
	this.scale = scale;
};

Potree.BinaryLoader.prototype.load = function (node) {
	if (node.loaded) {
		return;
	}

	var scope = this;

	var url = node.getURL();

	if (this.version.equalOrHigher("1.4")) {
		url += ".bin";
	}

	var xhr = new XMLHttpRequest();
	xhr.open('GET', url, true);
	xhr.responseType = 'arraybuffer';
	xhr.overrideMimeType('text/plain; charset=x-user-defined');
	xhr.onreadystatechange = function () {
		if (xhr.readyState === 4) {
			if (xhr.status === 200 || xhr.status === 0) {
				var buffer = xhr.response;
				scope.parse(node, buffer);
			} else {
				console.log('Failed to load file! HTTP status: ' + xhr.status + ", file: " + url);
			}
		}
	};
	try {
		xhr.send(null);
	} catch (e) {
		console.log("fehler beim laden der punktwolke: " + e);
	}
};

Potree.BinaryLoader.prototype.parse = function (node, buffer) {

	var numPoints = buffer.byteLength / node.pcoGeometry.pointAttributes.byteSize;
	var pointAttributes = node.pcoGeometry.pointAttributes;

	if (this.version.upTo("1.5")) {
		node.numPoints = numPoints;
	}

	var ww = Potree.workers.binaryDecoder.getWorker();
	ww.onmessage = function (e) {
		var data = e.data;
		var buffers = data.attributeBuffers;
		var tightBoundingBox = new THREE.Box3(new THREE.Vector3().fromArray(data.tightBoundingBox.min), new THREE.Vector3().fromArray(data.tightBoundingBox.max));

		Potree.workers.binaryDecoder.returnWorker(ww);

		var geometry = new THREE.BufferGeometry();

		for (var property in buffers) {
			if (buffers.hasOwnProperty(property)) {
				var buffer = buffers[property].buffer;
				var attribute = buffers[property].attribute;
				var numElements = attribute.numElements;

				if (parseInt(property) === Potree.PointAttributeNames.POSITION_CARTESIAN) {
					geometry.addAttribute("position", new THREE.BufferAttribute(new Float32Array(buffer), 3));
				} else if (parseInt(property) === Potree.PointAttributeNames.COLOR_PACKED) {
					geometry.addAttribute("color", new THREE.BufferAttribute(new Uint8Array(buffer), 3, true));
				} else if (parseInt(property) === Potree.PointAttributeNames.INTENSITY) {
					geometry.addAttribute("intensity", new THREE.BufferAttribute(new Float32Array(buffer), 1));
				} else if (parseInt(property) === Potree.PointAttributeNames.CLASSIFICATION) {
					geometry.addAttribute("classification", new THREE.BufferAttribute(new Uint8Array(buffer), 1));
				} else if (parseInt(property) === Potree.PointAttributeNames.NORMAL_SPHEREMAPPED) {
					geometry.addAttribute("normal", new THREE.BufferAttribute(new Float32Array(buffer), 3));
				} else if (parseInt(property) === Potree.PointAttributeNames.NORMAL_OCT16) {
					geometry.addAttribute("normal", new THREE.BufferAttribute(new Float32Array(buffer), 3));
				} else if (parseInt(property) === Potree.PointAttributeNames.NORMAL) {
					geometry.addAttribute("normal", new THREE.BufferAttribute(new Float32Array(buffer), 3));
				}
			}
		}
		geometry.addAttribute("indices", new THREE.BufferAttribute(new Float32Array(data.indices), 1));

		if (!geometry.attributes.normal) {
			var buffer = new Float32Array(numPoints * 3);
			geometry.addAttribute("normal", new THREE.BufferAttribute(new Float32Array(buffer), 3));
		}

		geometry.boundingBox = node.boundingBox;
		//geometry.boundingBox = tightBoundingBox;
		node.geometry = geometry;
		//node.boundingBox = tightBoundingBox;
		node.tightBoundingBox = tightBoundingBox;
		node.loaded = true;
		node.loading = false;
		node.pcoGeometry.numNodesLoading--;
	};

	var message = {
		buffer: buffer,
		pointAttributes: pointAttributes,
		version: this.version.version,
		min: [node.boundingBox.min.x, node.boundingBox.min.y, node.boundingBox.min.z],
		offset: [node.pcoGeometry.offset.x, node.pcoGeometry.offset.y, node.pcoGeometry.offset.z],
		scale: this.scale
	};
	ww.postMessage(message, [message.buffer]);
};
"use strict";

/**
 * laslaz code taken and adapted from plas.io js-laslaz
 *	http://plas.io/
 *  https://github.com/verma/plasio
 *
 * Thanks to Uday Verma and Howard Butler
 *
 */

Potree.LasLazLoader = function (version) {
	if (typeof version === "string") {
		this.version = new Potree.Version(version);
	} else {
		this.version = version;
	}
};

Potree.LasLazLoader.prototype.load = function (node) {

	if (node.loaded) {
		return;
	}

	//var url = node.pcoGeometry.octreeDir + "/" + node.name;
	var pointAttributes = node.pcoGeometry.pointAttributes;
	//var url = node.pcoGeometry.octreeDir + "/" + node.name + "." + pointAttributes.toLowerCase()

	var url = node.getURL();

	if (this.version.equalOrHigher("1.4")) {
		url += "." + pointAttributes.toLowerCase();
	}

	var scope = this;

	var xhr = new XMLHttpRequest();
	xhr.open('GET', url, true);
	xhr.responseType = 'arraybuffer';
	xhr.overrideMimeType('text/plain; charset=x-user-defined');
	xhr.onreadystatechange = function () {
		if (xhr.readyState === 4) {
			if (xhr.status === 200) {
				var buffer = xhr.response;
				//LasLazLoader.loadData(buffer, handler);
				scope.parse(node, buffer);
			} else {
				console.log('Failed to load file! HTTP status: ' + xhr.status + ", file: " + url);
			}
		}
	};

	xhr.send(null);
};

Potree.LasLazLoader.progressCB = function (arg) {};

Potree.LasLazLoader.prototype.parse = function loadData(node, buffer) {
	var lf = new LASFile(buffer);
	var handler = new Potree.LasLazBatcher(node);

	return Promise.resolve(lf).cancellable().then(function (lf) {
		return lf.open().then(function () {
			lf.isOpen = true;
			return lf;
		}).catch(Promise.CancellationError, function (e) {
			// open message was sent at this point, but then handler was not called
			// because the operation was cancelled, explicitly close the file
			return lf.close().then(function () {
				throw e;
			});
		});
	}).then(function (lf) {
		return lf.getHeader().then(function (h) {
			return [lf, h];
		});
	}).then(function (v) {
		var lf = v[0];
		var header = v[1];

		var skip = 1;
		var totalRead = 0;
		var totalToRead = skip <= 1 ? header.pointsCount : header.pointsCount / skip;
		var reader = function reader() {
			var p = lf.readData(1000000, 0, skip);
			return p.then(function (data) {
				handler.push(new LASDecoder(data.buffer, header.pointsFormatId, header.pointsStructSize, data.count, header.scale, header.offset, header.mins, header.maxs));

				totalRead += data.count;
				Potree.LasLazLoader.progressCB(totalRead / totalToRead);

				if (data.hasMoreData) return reader();else {

					header.totalRead = totalRead;
					header.versionAsString = lf.versionAsString;
					header.isCompressed = lf.isCompressed;
					return [lf, header, handler];
				}
			});
		};

		return reader();
	}).then(function (v) {
		var lf = v[0];
		// we're done loading this file
		//
		Potree.LasLazLoader.progressCB(1);

		// Close it
		return lf.close().then(function () {
			lf.isOpen = false;
			// Delay this a bit so that the user sees 100% completion
			//
			return Promise.delay(200).cancellable();
		}).then(function () {
			// trim off the first element (our LASFile which we don't really want to pass to the user)
			//
			return v.slice(1);
		});
	}).catch(Promise.CancellationError, function (e) {
		// If there was a cancellation, make sure the file is closed, if the file is open
		// close and then fail
		if (lf.isOpen) return lf.close().then(function () {
			lf.isOpen = false;
			throw e;
		});
		throw e;
	});
};

Potree.LasLazLoader.prototype.handle = function (node, url) {};

Potree.LasLazBatcher = function (node) {
	this.push = function (lasBuffer) {
		var ww = Potree.workers.lasdecoder.getWorker();
		var mins = new THREE.Vector3(lasBuffer.mins[0], lasBuffer.mins[1], lasBuffer.mins[2]);
		var maxs = new THREE.Vector3(lasBuffer.maxs[0], lasBuffer.maxs[1], lasBuffer.maxs[2]);
		mins.add(node.pcoGeometry.offset);
		maxs.add(node.pcoGeometry.offset);

		ww.onmessage = function (e) {
			var geometry = new THREE.BufferGeometry();
			var numPoints = lasBuffer.pointsCount;

			var endsWith = function endsWith(str, suffix) {
				return str.indexOf(suffix, str.length - suffix.length) !== -1;
			};

			var positions = e.data.position;
			var colors = new Uint8Array(e.data.color);
			var intensities = e.data.intensity;
			var classifications = new Uint8Array(e.data.classification);
			var returnNumbers = new Uint8Array(e.data.returnNumber);
			var numberOfReturns = new Uint8Array(e.data.numberOfReturns);
			var pointSourceIDs = new Uint16Array(e.data.pointSourceID);
			var indices = new ArrayBuffer(numPoints * 4);
			var iIndices = new Uint32Array(indices);

			var box = new THREE.Box3();

			var fPositions = new Float32Array(positions);
			for (var i = 0; i < numPoints; i++) {
				iIndices[i] = i;

				box.expandByPoint(new THREE.Vector3(fPositions[3 * i + 0], fPositions[3 * i + 1], fPositions[3 * i + 2]));
			}

			geometry.addAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
			geometry.addAttribute('color', new THREE.BufferAttribute(colors, 3, true));
			geometry.addAttribute('intensity', new THREE.BufferAttribute(new Float32Array(intensities), 1));
			geometry.addAttribute('classification', new THREE.BufferAttribute(classifications, 1));
			geometry.addAttribute('returnNumber', new THREE.BufferAttribute(returnNumbers, 1));
			geometry.addAttribute('numberOfReturns', new THREE.BufferAttribute(numberOfReturns, 1));
			geometry.addAttribute('pointSourceID', new THREE.BufferAttribute(pointSourceIDs, 1));
			geometry.addAttribute('indices', new THREE.BufferAttribute(indices, 1));
			geometry.addAttribute("normal", new THREE.BufferAttribute(new Float32Array(numPoints * 3), 3));

			var tightBoundingBox = new THREE.Box3(new THREE.Vector3().fromArray(e.data.tightBoundingBox.min), new THREE.Vector3().fromArray(e.data.tightBoundingBox.max));

			geometry.boundingBox = new THREE.Box3(mins, maxs);
			//geometry.boundingBox = tightBoundingBox;
			//node.boundingBox = geometry.boundingBox;
			node.tightBoundingBox = tightBoundingBox;

			node.geometry = geometry;
			node.loaded = true;
			node.loading = false;
			node.pcoGeometry.numNodesLoading--;

			Potree.workers.lasdecoder.returnWorker(ww);
		};

		var message = {
			buffer: lasBuffer.arrayb,
			numPoints: lasBuffer.pointsCount,
			pointSize: lasBuffer.pointSize,
			pointFormatID: 2,
			scale: lasBuffer.scale,
			offset: lasBuffer.offset,
			mins: [node.pcoGeometry.boundingBox.min.x, node.pcoGeometry.boundingBox.min.y, node.pcoGeometry.boundingBox.min.z],
			maxs: [node.pcoGeometry.boundingBox.max.x, node.pcoGeometry.boundingBox.max.y, node.pcoGeometry.boundingBox.max.z],
			bbOffset: [node.pcoGeometry.offset.x, node.pcoGeometry.offset.y, node.pcoGeometry.offset.z]
		};
		ww.postMessage(message, [message.buffer]);
	};
};
"use strict";

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

//
//
//
// how to calculate the radius of a projected sphere in screen space
// http://stackoverflow.com/questions/21648630/radius-of-projected-sphere-in-screen-space
// http://stackoverflow.com/questions/3717226/radius-of-projected-sphere
//

Potree.Gradients = {
	RAINBOW: [[0, new THREE.Color(0.278, 0, 0.714)], [1 / 6, new THREE.Color(0, 0, 1)], [2 / 6, new THREE.Color(0, 1, 1)], [3 / 6, new THREE.Color(0, 1, 0)], [4 / 6, new THREE.Color(1, 1, 0)], [5 / 6, new THREE.Color(1, 0.64, 0)], [1, new THREE.Color(1, 0, 0)]],
	GRAYSCALE: [[0, new THREE.Color(0, 0, 0)], [1, new THREE.Color(1, 1, 1)]]
};

Potree.Classification = {
	"DEFAULT": {
		0: new THREE.Vector4(0.5, 0.5, 0.5, 1.0),
		1: new THREE.Vector4(0.5, 0.5, 0.5, 1.0),
		2: new THREE.Vector4(0.63, 0.32, 0.18, 1.0),
		3: new THREE.Vector4(0.0, 1.0, 0.0, 1.0),
		4: new THREE.Vector4(0.0, 0.8, 0.0, 1.0),
		5: new THREE.Vector4(0.0, 0.6, 0.0, 1.0),
		6: new THREE.Vector4(1.0, 0.66, 0.0, 1.0),
		7: new THREE.Vector4(1.0, 0, 1.0, 1.0),
		8: new THREE.Vector4(1.0, 0, 0.0, 1.0),
		9: new THREE.Vector4(0.0, 0.0, 1.0, 1.0),
		12: new THREE.Vector4(1.0, 1.0, 0.0, 1.0),
		"DEFAULT": new THREE.Vector4(0.3, 0.6, 0.6, 0.5)
	}
};

Potree.PointSizeType = {
	FIXED: 0,
	ATTENUATED: 1,
	ADAPTIVE: 2
};

Potree.PointShape = {
	SQUARE: 0,
	CIRCLE: 1
};

Potree.PointColorType = {
	RGB: 0,
	COLOR: 1,
	DEPTH: 2,
	HEIGHT: 3,
	ELEVATION: 3,
	INTENSITY: 4,
	INTENSITY_GRADIENT: 5,
	LOD: 6,
	LEVEL_OF_DETAIL: 6,
	POINT_INDEX: 7,
	CLASSIFICATION: 8,
	RETURN_NUMBER: 9,
	SOURCE: 10,
	NORMAL: 11,
	PHONG: 12,
	RGB_HEIGHT: 13,
	COMPOSITE: 50
};

Potree.ClipMode = {
	DISABLED: 0,
	CLIP_OUTSIDE: 1,
	HIGHLIGHT_INSIDE: 2
};

Potree.TreeType = {
	OCTREE: 0,
	KDTREE: 1
};

Potree.PointCloudMaterial = function (parameters) {
	THREE.Material.call(this);

	parameters = parameters || {};

	this.visibleNodesTexture = Potree.utils.generateDataTexture(2048, 1, new THREE.Color(0xffffff));
	this.visibleNodesTexture.minFilter = THREE.NearestFilter;
	this.visibleNodesTexture.magFilter = THREE.NearestFilter;

	var pointSize = parameters.size || 1.0;
	var minSize = parameters.minSize || 1.0;
	var maxSize = parameters.maxSize || 50.0;
	var treeType = parameters.treeType || Potree.TreeType.OCTREE;

	this._pointSizeType = Potree.PointSizeType.ATTENUATED;
	this._pointShape = Potree.PointShape.SQUARE;
	this._interpolate = false;
	this._pointColorType = Potree.PointColorType.RGB;
	this._useClipBox = false;
	this.numClipBoxes = 0;
	this._clipMode = Potree.ClipMode.DISABLED;
	this._weighted = false;
	this._depthMap = null;
	this._gradient = Potree.Gradients.RAINBOW;
	this._classification = Potree.Classification.DEFAULT;
	this.gradientTexture = Potree.PointCloudMaterial.generateGradientTexture(this._gradient);
	this.classificationTexture = Potree.PointCloudMaterial.generateClassificationTexture(this._classification);
	this.lights = false;
	this.fog = false;
	this._treeType = treeType;
	this._useEDL = false;

	this.attributes = _defineProperty({
		position: { type: "fv", value: [] },
		color: { type: "fv", value: [] },
		normal: { type: "fv", value: [] },
		intensity: { type: "f", value: [] },
		classification: { type: "f", value: [] },
		returnNumber: { type: "f", value: [] },
		numberOfReturns: { type: "f", value: [] },
		pointSourceID: { type: "f", value: [] }
	}, "normal", { type: "f", value: [] });

	this.uniforms = {
		spacing: { type: "f", value: 1.0 },
		blendHardness: { type: "f", value: 2.0 },
		blendDepthSupplement: { type: "f", value: 0.0 },
		fov: { type: "f", value: 1.0 },
		screenWidth: { type: "f", value: 1.0 },
		screenHeight: { type: "f", value: 1.0 },
		near: { type: "f", value: 0.1 },
		far: { type: "f", value: 1.0 },
		uColor: { type: "c", value: new THREE.Color(0xffffff) },
		opacity: { type: "f", value: 1.0 },
		size: { type: "f", value: pointSize },
		minSize: { type: "f", value: minSize },
		maxSize: { type: "f", value: maxSize },
		octreeSize: { type: "f", value: 0 },
		bbSize: { type: "fv", value: [0, 0, 0] },
		heightMin: { type: "f", value: 0.0 },
		heightMax: { type: "f", value: 1.0 },
		intensityMin: { type: "f", value: 0.0 },
		intensityMax: { type: "f", value: 1.0 },
		clipBoxCount: { type: "f", value: 0 },
		visibleNodes: { type: "t", value: this.visibleNodesTexture },
		pcIndex: { type: "f", value: 0 },
		gradient: { type: "t", value: this.gradientTexture },
		classificationLUT: { type: "t", value: this.classificationTexture },
		clipBoxes: { type: "Matrix4fv", value: [] },
		clipBoxPositions: { type: "fv", value: null },
		depthMap: { type: "t", value: null },
		diffuse: { type: "fv", value: [1, 1, 1] },
		transition: { type: "f", value: 0.5 },
		intensityRange: { type: "fv", value: [0, 65000] },
		intensityGamma: { type: "f", value: 1 },
		intensityContrast: { type: "f", value: 0 },
		intensityBrightness: { type: "f", value: 0 },
		rgbGamma: { type: "f", value: 1 },
		rgbContrast: { type: "f", value: 0 },
		rgbBrightness: { type: "f", value: 0 },
		wRGB: { type: "f", value: 1 },
		wIntensity: { type: "f", value: 0 },
		wElevation: { type: "f", value: 0 },
		wClassification: { type: "f", value: 0 },
		wReturnNumber: { type: "f", value: 0 },
		wSourceID: { type: "f", value: 0 }
	};

	this.defaultAttributeValues.normal = [0, 0, 0];
	this.defaultAttributeValues.classification = [0, 0, 0];

	this.vertexShader = this.getDefines() + Potree.Shaders["pointcloud.vs"];
	this.fragmentShader = this.getDefines() + Potree.Shaders["pointcloud.fs"];
	this.vertexColors = THREE.VertexColors;
};

Potree.PointCloudMaterial.prototype = new THREE.RawShaderMaterial();

//Potree.PointCloudMaterial.prototype.copyFrom = function(source){
//
//	for(let uniform of source.uniforms){
//		this.uniforms.value = source.uniforms.value;
//	}
//
//	this.pointSizeType = source.pointSizeType;
//
//};
//
//Potree.PointCloudMaterial.prototype.clone = function(){
//	let material = new Potree.PointCloudMaterial();
//	material.copyFrom(this);
//
//	return material;
//};

Potree.PointCloudMaterial.prototype.updateShaderSource = function () {

	this.vertexShader = this.getDefines() + Potree.Shaders["pointcloud.vs"];
	this.fragmentShader = this.getDefines() + Potree.Shaders["pointcloud.fs"];

	if (this.depthMap) {
		this.uniforms.depthMap.value = this.depthMap;
		this.depthMap = depthMap;
		//this.setValues({
		//	depthMap: this.depthMap,
		//});
	}

	if (this.opacity === 1.0) {
		this.blending = THREE.NoBlending;
		this.transparent = false;
		this.depthTest = true;
		this.depthWrite = true;
	} else {
		this.blending = THREE.AdditiveBlending;
		this.transparent = true;
		this.depthTest = false;
		this.depthWrite = true;
	}

	if (this.weighted) {
		this.blending = THREE.AdditiveBlending;
		this.transparent = true;
		this.depthTest = true;
		this.depthWrite = false;
	}

	this.needsUpdate = true;
};

Potree.PointCloudMaterial.prototype.getDefines = function () {

	var defines = "";

	if (this.pointSizeType === Potree.PointSizeType.FIXED) {
		defines += "#define fixed_point_size\n";
	} else if (this.pointSizeType === Potree.PointSizeType.ATTENUATED) {
		defines += "#define attenuated_point_size\n";
	} else if (this.pointSizeType === Potree.PointSizeType.ADAPTIVE) {
		defines += "#define adaptive_point_size\n";
	}

	if (this.pointShape === Potree.PointShape.SQUARE) {
		defines += "#define square_point_shape\n";
	} else if (this.pointShape === Potree.PointShape.CIRCLE) {
		defines += "#define circle_point_shape\n";
	}

	if (this._interpolate) {
		defines += "#define use_interpolation\n";
	}

	if (this._useEDL) {
		defines += "#define use_edl\n";
	}

	if (this._pointColorType === Potree.PointColorType.RGB) {
		defines += "#define color_type_rgb\n";
	} else if (this._pointColorType === Potree.PointColorType.COLOR) {
		defines += "#define color_type_color\n";
	} else if (this._pointColorType === Potree.PointColorType.DEPTH) {
		defines += "#define color_type_depth\n";
	} else if (this._pointColorType === Potree.PointColorType.HEIGHT) {
		defines += "#define color_type_height\n";
	} else if (this._pointColorType === Potree.PointColorType.INTENSITY) {
		defines += "#define color_type_intensity\n";
	} else if (this._pointColorType === Potree.PointColorType.INTENSITY_GRADIENT) {
		defines += "#define color_type_intensity_gradient\n";
	} else if (this._pointColorType === Potree.PointColorType.LOD) {
		defines += "#define color_type_lod\n";
	} else if (this._pointColorType === Potree.PointColorType.POINT_INDEX) {
		defines += "#define color_type_point_index\n";
	} else if (this._pointColorType === Potree.PointColorType.CLASSIFICATION) {
		defines += "#define color_type_classification\n";
	} else if (this._pointColorType === Potree.PointColorType.RETURN_NUMBER) {
		defines += "#define color_type_return_number\n";
	} else if (this._pointColorType === Potree.PointColorType.SOURCE) {
		defines += "#define color_type_source\n";
	} else if (this._pointColorType === Potree.PointColorType.NORMAL) {
		defines += "#define color_type_normal\n";
	} else if (this._pointColorType === Potree.PointColorType.PHONG) {
		defines += "#define color_type_phong\n";
	} else if (this._pointColorType === Potree.PointColorType.RGB_HEIGHT) {
		defines += "#define color_type_rgb_height\n";
	} else if (this._pointColorType === Potree.PointColorType.COMPOSITE) {
		defines += "#define color_type_composite\n";
	}

	if (this.clipMode === Potree.ClipMode.DISABLED) {
		defines += "#define clip_disabled\n";
	} else if (this.clipMode === Potree.ClipMode.CLIP_OUTSIDE) {
		defines += "#define clip_outside\n";
	} else if (this.clipMode === Potree.ClipMode.HIGHLIGHT_INSIDE) {
		defines += "#define clip_highlight_inside\n";
	}

	if (this._treeType === Potree.TreeType.OCTREE) {
		defines += "#define tree_type_octree\n";
	} else if (this._treeType === Potree.TreeType.KDTREE) {
		defines += "#define tree_type_kdtree\n";
	}

	if (this.weighted) {
		defines += "#define weighted_splats\n";
	}

	if (this.numClipBoxes > 0) {
		defines += "#define use_clip_box\n";
	}

	return defines;
};

Potree.PointCloudMaterial.prototype.setClipBoxes = function (clipBoxes) {
	if (!clipBoxes) {
		return;
	}

	this.clipBoxes = clipBoxes;
	var doUpdate = this.numClipBoxes != clipBoxes.length && (clipBoxes.length === 0 || this.numClipBoxes === 0);

	this.numClipBoxes = clipBoxes.length;
	this.uniforms.clipBoxCount.value = this.numClipBoxes;

	if (doUpdate) {
		this.updateShaderSource();
	}

	this.uniforms.clipBoxes.value = new Float32Array(this.numClipBoxes * 16);
	this.uniforms.clipBoxPositions.value = new Float32Array(this.numClipBoxes * 3);

	for (var i = 0; i < this.numClipBoxes; i++) {
		var box = clipBoxes[i];

		this.uniforms.clipBoxes.value.set(box.inverse.elements, 16 * i);

		this.uniforms.clipBoxPositions.value[3 * i + 0] = box.position.x;
		this.uniforms.clipBoxPositions.value[3 * i + 1] = box.position.y;
		this.uniforms.clipBoxPositions.value[3 * i + 2] = box.position.z;
	}
};

Object.defineProperty(Potree.PointCloudMaterial.prototype, "gradient", {
	get: function get() {
		return this._gradient;
	},
	set: function set(value) {
		if (this._gradient !== value) {
			this._gradient = value;
			this.gradientTexture = Potree.PointCloudMaterial.generateGradientTexture(this._gradient);
			this.uniforms.gradient.value = this.gradientTexture;
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "classification", {
	get: function get() {
		return this._classification;
	},
	set: function set(value) {
		//if(this._classification !== value){
		this._classification = value;
		this.classificationTexture = Potree.PointCloudMaterial.generateClassificationTexture(this._classification);
		this.uniforms.classificationLUT.value = this.classificationTexture;
		//}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "spacing", {
	get: function get() {
		return this.uniforms.spacing.value;
	},
	set: function set(value) {
		if (this.uniforms.spacing.value !== value) {
			this.uniforms.spacing.value = value;
			//this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "useClipBox", {
	get: function get() {
		return this._useClipBox;
	},
	set: function set(value) {
		if (this._useClipBox !== value) {
			this._useClipBox = value;
			this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "weighted", {
	get: function get() {
		return this._weighted;
	},
	set: function set(value) {
		if (this._weighted !== value) {
			this._weighted = value;
			this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "fov", {
	get: function get() {
		return this.uniforms.fov.value;
	},
	set: function set(value) {
		if (this.uniforms.fov.value !== value) {
			this.uniforms.fov.value = value;
			//this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "screenWidth", {
	get: function get() {
		return this.uniforms.screenWidth.value;
	},
	set: function set(value) {
		if (this.uniforms.screenWidth.value !== value) {
			this.uniforms.screenWidth.value = value;
			//this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "screenHeight", {
	get: function get() {
		return this.uniforms.screenHeight.value;
	},
	set: function set(value) {
		if (this.uniforms.screenHeight.value !== value) {
			this.uniforms.screenHeight.value = value;
			//this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "near", {
	get: function get() {
		return this.uniforms.near.value;
	},
	set: function set(value) {
		if (this.uniforms.near.value !== value) {
			this.uniforms.near.value = value;
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "far", {
	get: function get() {
		return this.uniforms.far.value;
	},
	set: function set(value) {
		if (this.uniforms.far.value !== value) {
			this.uniforms.far.value = value;
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "opacity", {
	get: function get() {
		return this.uniforms.opacity.value;
	},
	set: function set(value) {
		if (this.uniforms.opacity) {
			if (this.uniforms.opacity.value !== value) {
				this.uniforms.opacity.value = value;
				this.updateShaderSource();
			}
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "pointColorType", {
	get: function get() {
		return this._pointColorType;
	},
	set: function set(value) {
		if (this._pointColorType !== value) {
			this._pointColorType = value;
			this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "depthMap", {
	get: function get() {
		return this._depthMap;
	},
	set: function set(value) {
		if (this._depthMap !== value) {
			this._depthMap = value;
			this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "pointSizeType", {
	get: function get() {
		return this._pointSizeType;
	},
	set: function set(value) {
		if (this._pointSizeType !== value) {
			this._pointSizeType = value;
			this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "clipMode", {
	get: function get() {
		return this._clipMode;
	},
	set: function set(value) {
		if (this._clipMode !== value) {
			this._clipMode = value;
			this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "interpolate", {
	get: function get() {
		return this._interpolate;
	},
	set: function set(value) {
		if (this._interpolate !== value) {
			this._interpolate = value;
			this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "useEDL", {
	get: function get() {
		return this._useEDL;
	},
	set: function set(value) {
		if (this._useEDL !== value) {
			this._useEDL = value;
			this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "color", {
	get: function get() {
		return this.uniforms.uColor.value;
	},
	set: function set(value) {
		if (this.uniforms.uColor.value !== value) {
			this.uniforms.uColor.value.copy(value);
			this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "pointShape", {
	get: function get() {
		return this._pointShape;
	},
	set: function set(value) {
		if (this._pointShape !== value) {
			this._pointShape = value;
			this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "treeType", {
	get: function get() {
		return this._treeType;
	},
	set: function set(value) {
		if (this._treeType != value) {
			this._treeType = value;
			this.updateShaderSource();
		}
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "bbSize", {
	get: function get() {
		return this.uniforms.bbSize.value;
	},
	set: function set(value) {
		this.uniforms.bbSize.value = value;
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "size", {
	get: function get() {
		return this.uniforms.size.value;
	},
	set: function set(value) {
		this.uniforms.size.value = value;
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "heightMin", {
	get: function get() {
		return this.uniforms.heightMin.value;
	},
	set: function set(value) {
		this.uniforms.heightMin.value = value;
	}
});

Object.defineProperty(Potree.PointCloudMaterial.prototype, "heightMax", {
	get: function get() {
		return this.uniforms.heightMax.value;
	},
	set: function set(value) {
		this.uniforms.heightMax.value = value;
	}
});

/**
 * Generates a look-up texture for gradient values (height, intensity, ...)
 *
 */
Potree.PointCloudMaterial.generateGradientTexture = function (gradient) {
	var size = 64;

	// create canvas
	var canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;

	// get context
	var context = canvas.getContext('2d');

	// draw gradient
	context.rect(0, 0, size, size);
	var ctxGradient = context.createLinearGradient(0, 0, size, size);

	for (var i = 0; i < gradient.length; i++) {
		var step = gradient[i];

		ctxGradient.addColorStop(step[0], "#" + step[1].getHexString());
	}

	context.fillStyle = ctxGradient;
	context.fill();

	var texture = new THREE.Texture(canvas);
	texture.needsUpdate = true;
	//textureImage = texture.image;

	return texture;
};

/**
 * Generates a look up texture for classification colors
 *
 */
Potree.PointCloudMaterial.generateClassificationTexture = function (classification) {
	var width = 256;
	var height = 256;
	var size = width * height;

	var data = new Uint8Array(4 * size);

	for (var x = 0; x < width; x++) {
		for (var y = 0; y < height; y++) {
			var u = 2 * (x / width) - 1;
			var v = 2 * (y / height) - 1;

			var i = x + width * y;

			var color;
			if (classification[x]) {
				color = classification[x];
			} else {
				color = classification.DEFAULT;
			}

			data[4 * i + 0] = 255 * color.x;
			data[4 * i + 1] = 255 * color.y;
			data[4 * i + 2] = 255 * color.z;
			data[4 * i + 3] = 255 * color.w;
		}
	}

	var texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
	texture.magFilter = THREE.NearestFilter;
	texture.needsUpdate = true;

	return texture;
};
"use strict";

//
// Algorithm by Christian Boucheny
// shader code taken and adapted from CloudCompare
//
// see
// https://github.com/cloudcompare/trunk/tree/master/plugins/qEDL/shaders/EDL
// http://www.kitware.com/source/home/post/9
// https://tel.archives-ouvertes.fr/tel-00438464/document p. 115+ (french)


Potree.EyeDomeLightingMaterial = function (parameters) {
	THREE.Material.call(this);

	parameters = parameters || {};

	this._neighbourCount = 4;
	this.neighbours = new Float32Array(this.neighbourCount * 2);
	for (var c = 0; c < this.neighbourCount; c++) {
		this.neighbours[2 * c + 0] = Math.cos(2 * c * Math.PI / this.neighbourCount);
		this.neighbours[2 * c + 1] = Math.sin(2 * c * Math.PI / this.neighbourCount);
	}

	var lightDir = new THREE.Vector3(0.0, 0.0, 1.0).normalize();

	var uniforms = {
		screenWidth: { type: "f", value: 0 },
		screenHeight: { type: "f", value: 0 },
		edlStrength: { type: "f", value: 1.0 },
		radius: { type: "f", value: 1.0 },
		neighbours: { type: "2fv", value: this.neighbours },
		depthMap: { type: "t", value: null },
		colorMap: { type: "t", value: null },
		opacity: { type: "f", value: 1.0 }
	};

	this.setValues({
		uniforms: uniforms,
		vertexShader: this.getDefines() + Potree.Shaders["edl.vs"],
		fragmentShader: this.getDefines() + Potree.Shaders["edl.fs"],
		lights: false
	});
};

Potree.EyeDomeLightingMaterial.prototype = new THREE.ShaderMaterial();

Potree.EyeDomeLightingMaterial.prototype.getDefines = function () {
	var defines = "";

	defines += "#define NEIGHBOUR_COUNT " + this.neighbourCount + "\n";

	return defines;
};

Potree.EyeDomeLightingMaterial.prototype.updateShaderSource = function () {
	var attributes = {};
	if (this.pointColorType === Potree.PointColorType.INTENSITY || this.pointColorType === Potree.PointColorType.INTENSITY_GRADIENT) {
		attributes.intensity = { type: "f", value: [] };
	} else if (this.pointColorType === Potree.PointColorType.CLASSIFICATION) {
		//attributes.classification = { type: "f", value: [] };
	} else if (this.pointColorType === Potree.PointColorType.RETURN_NUMBER) {
		attributes.returnNumber = { type: "f", value: [] };
		attributes.numberOfReturns = { type: "f", value: [] };
	} else if (this.pointColorType === Potree.PointColorType.SOURCE) {
		attributes.pointSourceID = { type: "f", value: [] };
	} else if (this.pointColorType === Potree.PointColorType.NORMAL || this.pointColorType === Potree.PointColorType.PHONG) {
		attributes.normal = { type: "f", value: [] };
	}
	attributes.classification = { type: "f", value: 0 };

	var vs = this.getDefines() + Potree.Shaders["edl.vs"];
	var fs = this.getDefines() + Potree.Shaders["edl.fs"];

	this.setValues({
		vertexShader: vs,
		fragmentShader: fs
	});

	this.uniforms.neighbours.value = this.neighbours;

	this.needsUpdate = true;
};

Object.defineProperty(Potree.EyeDomeLightingMaterial.prototype, "neighbourCount", {
	get: function get() {
		return this._neighbourCount;
	},
	set: function set(value) {
		if (this._neighbourCount !== value) {
			this._neighbourCount = value;
			this.neighbours = new Float32Array(this._neighbourCount * 2);
			for (var c = 0; c < this._neighbourCount; c++) {
				this.neighbours[2 * c + 0] = Math.cos(2 * c * Math.PI / this._neighbourCount);
				this.neighbours[2 * c + 1] = Math.sin(2 * c * Math.PI / this._neighbourCount);
			}

			this.updateShaderSource();
		}
	}
});
"use strict";

// see http://john-chapman-graphics.blogspot.co.at/2013/01/ssao-tutorial.html


Potree.BlurMaterial = function (parameters) {
	THREE.Material.call(this);

	parameters = parameters || {};

	var uniforms = {
		near: { type: "f", value: 0 },
		far: { type: "f", value: 0 },
		screenWidth: { type: "f", value: 0 },
		screenHeight: { type: "f", value: 0 },
		map: { type: "t", value: null }
	};

	this.setValues({
		uniforms: uniforms,
		vertexShader: Potree.Shaders["blur.vs"],
		fragmentShader: Potree.Shaders["blur.fs"]
	});
};

Potree.BlurMaterial.prototype = new THREE.ShaderMaterial();
'use strict';

/**
 * @author mschuetz / http://mschuetz.at
 *
 * adapted from THREE.OrbitControls by 
 *
 * @author qiao / https://github.com/qiao
 * @author mrdoob / http://mrdoob.com
 * @author alteredq / http://alteredqualia.com/
 * @author WestLangley / http://github.com/WestLangley
 * @author erich666 / http://erichaines.com
 *
 * This set of controls performs first person navigation without mouse lock.
 * Instead, rotating the camera is done by dragging with the left mouse button.
 *
 * move: a/s/d/w or up/down/left/right
 * rotate: left mouse
 * pan: right mouse
 * change speed: mouse wheel
 *
 *
 */

THREE.FirstPersonControls = function (object, domElement) {
	this.object = object;
	this.domElement = domElement !== undefined ? domElement : document;

	// Set to false to disable this control
	this.enabled = true;

	this.rotateSpeed = 1.0;
	this.moveSpeed = 10.0;

	this.keys = {
		LEFT: 37,
		UP: 38,
		RIGHT: 39,
		BOTTOM: 40,
		A: 'A'.charCodeAt(0),
		S: 'S'.charCodeAt(0),
		D: 'D'.charCodeAt(0),
		W: 'W'.charCodeAt(0)
	};

	var scope = this;

	var rotateStart = new THREE.Vector2();
	var rotateEnd = new THREE.Vector2();
	var rotateDelta = new THREE.Vector2();

	var panStart = new THREE.Vector2();
	var panEnd = new THREE.Vector2();
	var panDelta = new THREE.Vector2();
	var panOffset = new THREE.Vector3();

	var offset = new THREE.Vector3();

	var phiDelta = 0;
	var thetaDelta = 0;
	var scale = 1;
	var pan = new THREE.Vector3();

	var lastPosition = new THREE.Vector3();

	var STATE = { NONE: -1, ROTATE: 0, SPEEDCHANGE: 1, PAN: 2 };

	var state = STATE.NONE;

	// for reset
	this.position0 = this.object.position.clone();

	// events

	var changeEvent = { type: 'change' };
	var startEvent = { type: 'start' };
	var endEvent = { type: 'end' };

	this.rotateLeft = function (angle) {
		thetaDelta -= angle;
	};

	this.rotateUp = function (angle) {
		phiDelta -= angle;
	};

	// pass in distance in world space to move left
	this.panLeft = function (distance) {

		var te = this.object.matrix.elements;

		// get X column of matrix
		panOffset.set(te[0], te[1], te[2]);
		panOffset.multiplyScalar(-distance);

		pan.add(panOffset);
	};

	// pass in distance in world space to move up
	this.panUp = function (distance) {

		var te = this.object.matrix.elements;

		// get Y column of matrix
		panOffset.set(te[4], te[5], te[6]);
		panOffset.multiplyScalar(distance);

		pan.add(panOffset);
	};

	// pass in distance in world space to move forward
	this.panForward = function (distance) {

		var te = this.object.matrix.elements;

		// get Y column of matrix
		panOffset.set(te[8], te[9], te[10]);
		panOffset.multiplyScalar(distance);

		pan.add(panOffset);
	};

	this.pan = function (deltaX, deltaY) {

		var element = scope.domElement === document ? scope.domElement.body : scope.domElement;

		if (scope.object.fov !== undefined) {
			// perspective
			var position = scope.object.position;
			var offset = position.clone();
			var targetDistance = offset.length();

			// half of the fov is center to top of screen
			targetDistance *= Math.tan(scope.object.fov / 2 * Math.PI / 180.0);

			// we actually don't use screenWidth, since perspective camera is fixed to screen height
			scope.panLeft(2 * deltaX * targetDistance / element.clientHeight);
			scope.panUp(2 * deltaY * targetDistance / element.clientHeight);
		} else if (scope.object.top !== undefined) {

			// orthographic
			scope.panLeft(deltaX * (scope.object.right - scope.object.left) / element.clientWidth);
			scope.panUp(deltaY * (scope.object.top - scope.object.bottom) / element.clientHeight);
		} else {

			// camera neither orthographic or perspective
			console.warn('WARNING: FirstPersonControls.js encountered an unknown camera type - pan disabled.');
		}
	};

	this.update = function (delta) {
		this.object.rotation.order = 'ZYX';

		var object = this.object;

		this.object = new THREE.Object3D();
		this.object.position.copy(object.position);
		this.object.rotation.copy(object.rotation);
		this.object.updateMatrix();
		this.object.updateMatrixWorld();

		var position = this.object.position;

		if (delta !== undefined) {
			if (this.moveRight) {
				this.panLeft(-delta * this.moveSpeed);
			}
			if (this.moveLeft) {
				this.panLeft(delta * this.moveSpeed);
			}
			if (this.moveForward) {
				this.panForward(-delta * this.moveSpeed);
			}
			if (this.moveBackward) {
				this.panForward(delta * this.moveSpeed);
			}
		}

		if (!pan.equals(new THREE.Vector3(0, 0, 0))) {
			var event = {
				type: 'move',
				translation: pan.clone()
			};
			this.dispatchEvent(event);
		}

		position.add(pan);

		if (!(thetaDelta === 0.0 && phiDelta === 0.0)) {
			var event = {
				type: 'rotate',
				thetaDelta: thetaDelta,
				phiDelta: phiDelta
			};
			this.dispatchEvent(event);
		}

		this.object.updateMatrix();
		var rot = new THREE.Matrix4().makeRotationY(thetaDelta);
		var res = new THREE.Matrix4().multiplyMatrices(rot, this.object.matrix);
		this.object.quaternion.setFromRotationMatrix(res);

		this.object.rotation.x += phiDelta;
		this.object.updateMatrixWorld();

		// send transformation proposal to listeners
		var proposeTransformEvent = {
			type: "proposeTransform",
			oldPosition: object.position,
			newPosition: this.object.position,
			objections: 0,
			counterProposals: []
		};
		this.dispatchEvent(proposeTransformEvent);

		// check some counter proposals if transformation wasn't accepted
		if (proposeTransformEvent.objections > 0) {
			if (proposeTransformEvent.counterProposals.length > 0) {
				var cp = proposeTransformEvent.counterProposals;
				this.object.position.copy(cp[0]);

				proposeTransformEvent.objections = 0;
				proposeTransformEvent.counterProposals = [];
			}
		}

		// apply transformation, if accepted
		if (proposeTransformEvent.objections > 0) {} else {
			object.position.copy(this.object.position);
		}

		object.rotation.copy(this.object.rotation);

		this.object = object;

		thetaDelta = 0;
		phiDelta = 0;
		scale = 1;
		pan.set(0, 0, 0);

		if (lastPosition.distanceTo(this.object.position) > 0) {
			this.dispatchEvent(changeEvent);

			lastPosition.copy(this.object.position);
		}
	};

	this.reset = function () {
		state = STATE.NONE;

		this.object.position.copy(this.position0);
	};

	function onMouseDown(event) {
		if (scope.enabled === false) return;
		event.preventDefault();

		if (event.button === 0) {
			state = STATE.ROTATE;

			rotateStart.set(event.clientX, event.clientY);
		} else if (event.button === 2) {
			state = STATE.PAN;

			panStart.set(event.clientX, event.clientY);
		}

		scope.domElement.addEventListener('mousemove', onMouseMove, false);
		scope.domElement.addEventListener('mouseup', onMouseUp, false);
		scope.dispatchEvent(startEvent);
	}

	function onMouseMove(event) {
		if (scope.enabled === false) return;

		event.preventDefault();

		var element = scope.domElement === document ? scope.domElement.body : scope.domElement;

		if (state === STATE.ROTATE) {
			rotateEnd.set(event.clientX, event.clientY);
			rotateDelta.subVectors(rotateEnd, rotateStart);

			// rotating across whole screen goes 360 degrees around
			scope.rotateLeft(2 * Math.PI * rotateDelta.x / element.clientWidth * scope.rotateSpeed);

			// rotating up and down along whole screen attempts to go 360, but limited to 180
			scope.rotateUp(2 * Math.PI * rotateDelta.y / element.clientHeight * scope.rotateSpeed);

			rotateStart.copy(rotateEnd);
		} else if (state === STATE.PAN) {
			panEnd.set(event.clientX, event.clientY);
			panDelta.subVectors(panEnd, panStart);
			//panDelta.multiplyScalar(this.moveSpeed).multiplyScalar(0.0001);
			panDelta.multiplyScalar(0.0005).multiplyScalar(scope.moveSpeed);

			scope.pan(panDelta.x, panDelta.y);

			panStart.copy(panEnd);
		}
	}

	function onMouseUp() {
		if (scope.enabled === false) return;

		scope.domElement.removeEventListener('mousemove', onMouseMove, false);
		scope.domElement.removeEventListener('mouseup', onMouseUp, false);
		scope.dispatchEvent(endEvent);
		state = STATE.NONE;
	}

	function onMouseWheel(event) {
		if (scope.enabled === false || scope.noZoom === true) return;

		event.preventDefault();

		var direction = event.detail < 0 || event.wheelDelta > 0 ? 1 : -1;

		var moveSpeed = scope.moveSpeed + scope.moveSpeed * 0.1 * direction;
		moveSpeed = Math.max(0.1, moveSpeed);

		scope.setMoveSpeed(moveSpeed);

		scope.dispatchEvent(startEvent);
		scope.dispatchEvent(endEvent);
	}

	this.setMoveSpeed = function (value) {
		if (scope.moveSpeed !== value) {
			scope.moveSpeed = value;
			scope.dispatchEvent({
				type: "move_speed_changed",
				controls: scope
			});
		}
	};

	function onKeyDown(event) {
		if (scope.enabled === false) return;

		switch (event.keyCode) {
			case scope.keys.UP:
				scope.moveForward = true;break;
			case scope.keys.BOTTOM:
				scope.moveBackward = true;break;
			case scope.keys.LEFT:
				scope.moveLeft = true;break;
			case scope.keys.RIGHT:
				scope.moveRight = true;break;
			case scope.keys.W:
				scope.moveForward = true;break;
			case scope.keys.S:
				scope.moveBackward = true;break;
			case scope.keys.A:
				scope.moveLeft = true;break;
			case scope.keys.D:
				scope.moveRight = true;break;
		}

		//if(scope.moveForward || scope.moveBackward || scope.moveLeft || scope.moveRight){
		//			scope.dispatchEvent( startEvent );
		//	}
	}

	function onKeyUp(event) {
		switch (event.keyCode) {
			case scope.keys.W:
				scope.moveForward = false;break;
			case scope.keys.S:
				scope.moveBackward = false;break;
			case scope.keys.A:
				scope.moveLeft = false;break;
			case scope.keys.D:
				scope.moveRight = false;break;
			case scope.keys.UP:
				scope.moveForward = false;break;
			case scope.keys.BOTTOM:
				scope.moveBackward = false;break;
			case scope.keys.LEFT:
				scope.moveLeft = false;break;
			case scope.keys.RIGHT:
				scope.moveRight = false;break;
		}
	}

	this.domElement.addEventListener('contextmenu', function (event) {
		event.preventDefault();
	}, false);
	this.domElement.addEventListener('mousedown', onMouseDown, false);
	this.domElement.addEventListener('mousewheel', onMouseWheel, false);
	this.domElement.addEventListener('DOMMouseScroll', onMouseWheel, false); // firefox

	if (this.domElement.tabIndex === -1) {
		this.domElement.tabIndex = 2222;
	}
	this.domElement.addEventListener('keydown', onKeyDown, false);
	this.domElement.addEventListener('keyup', onKeyUp, false);

	//document.body.addEventListener( 'keydown', onKeyDown, false );
	//document.body.addEventListener( 'keyup', onKeyUp, false );
};

THREE.FirstPersonControls.prototype = Object.create(THREE.EventDispatcher.prototype);
'use strict';

/**
 * @author mschuetz / http://mschuetz.at
 *
 * adapted from THREE.OrbitControls by 
 *
 * @author qiao / https://github.com/qiao
 * @author mrdoob / http://mrdoob.com
 * @author alteredq / http://alteredqualia.com/
 * @author WestLangley / http://github.com/WestLangley
 * @author erich666 / http://erichaines.com
 *
 * This set of controls performs first person navigation without mouse lock.
 * Instead, rotating the camera is done by dragging with the left mouse button.
 *
 * move: a/s/d/w or up/down/left/right
 * rotate: left mouse
 * pan: right mouse
 * change speed: mouse wheel
 *
 *
 */

Potree.GeoControls = function (object, domElement) {
	this.object = object;
	this.domElement = domElement !== undefined ? domElement : document;

	// Set to false to disable this control
	this.enabled = true;

	// Set this to a THREE.SplineCurve3 instance
	this.track = null;
	// position on track in intervall [0,1]
	this.trackPos = 0;

	this.rotateSpeed = 1.0;
	this.moveSpeed = 10.0;

	this.keys = {
		LEFT: 37,
		UP: 38,
		RIGHT: 39,
		BOTTOM: 40,
		A: 'A'.charCodeAt(0),
		S: 'S'.charCodeAt(0),
		D: 'D'.charCodeAt(0),
		W: 'W'.charCodeAt(0),
		Q: 'Q'.charCodeAt(0),
		E: 'E'.charCodeAt(0),
		R: 'R'.charCodeAt(0),
		F: 'F'.charCodeAt(0)
	};

	var scope = this;

	var rotateStart = new THREE.Vector2();
	var rotateEnd = new THREE.Vector2();
	var rotateDelta = new THREE.Vector2();

	var panStart = new THREE.Vector2();
	var panEnd = new THREE.Vector2();
	var panDelta = new THREE.Vector2();
	var panOffset = new THREE.Vector3();

	var offset = new THREE.Vector3();

	var phiDelta = 0;
	var thetaDelta = 0;
	var scale = 1;
	var pan = new THREE.Vector3();

	this.shiftDown = false;

	var lastPosition = new THREE.Vector3();

	var STATE = { NONE: -1, ROTATE: 0, SPEEDCHANGE: 1, PAN: 2 };

	var state = STATE.NONE;

	// for reset
	this.position0 = this.object.position.clone();

	// events

	var changeEvent = { type: 'change' };
	var startEvent = { type: 'start' };
	var endEvent = { type: 'end' };

	this.setTrack = function (track) {
		if (this.track !== track) {
			this.track = track;
			this.trackPos = null;
		}
	};

	this.setTrackPos = function (trackPos, _preserveRelativeRotation) {
		var preserveRelativeRotation = _preserveRelativeRotation || false;

		var newTrackPos = Math.max(0, Math.min(1, trackPos));
		var oldTrackPos = this.trackPos || newTrackPos;

		var newTangent = this.track.getTangentAt(newTrackPos);
		var oldTangent = this.track.getTangentAt(oldTrackPos);

		if (newTangent.equals(oldTangent)) {
			// no change in direction
		} else {
			var tangentDiffNormal = new THREE.Vector3().crossVectors(oldTangent, newTangent).normalize();
			var angle = oldTangent.angleTo(newTangent);
			var rot = new THREE.Matrix4().makeRotationAxis(tangentDiffNormal, angle);
			var dir = this.object.getWorldDirection().clone();
			dir = dir.applyMatrix4(rot);
			var target = new THREE.Vector3().addVectors(this.object.position, dir);
			this.object.lookAt(target);
			this.object.updateMatrixWorld();

			var event = {
				type: 'path_relative_rotation',
				angle: angle,
				axis: tangentDiffNormal,
				controls: scope
			};
			this.dispatchEvent(event);
		}

		if (this.trackPos === null) {
			var target = new THREE.Vector3().addVectors(this.object.position, newTangent);
			this.object.lookAt(target);
		}

		this.trackPos = newTrackPos;

		//var pStart = this.track.getPointAt(oldTrackPos);
		//var pEnd = this.track.getPointAt(newTrackPos);
		//var pDiff = pEnd.sub(pStart);


		if (newTrackPos !== oldTrackPos) {
			var event = {
				type: 'move',
				translation: pan.clone()
			};
			this.dispatchEvent(event);
		}
	};

	this.getTrackPos = function () {
		return this.trackPos;
	};

	this.rotateLeft = function (angle) {
		thetaDelta -= angle;
	};

	this.rotateUp = function (angle) {
		phiDelta -= angle;
	};

	// pass in distance in world space to move left
	this.panLeft = function (distance) {

		var te = this.object.matrix.elements;

		// get X column of matrix
		panOffset.set(te[0], te[1], te[2]);
		panOffset.multiplyScalar(-distance);

		pan.add(panOffset);
	};

	// pass in distance in world space to move up
	this.panUp = function (distance) {

		var te = this.object.matrix.elements;

		// get Y column of matrix
		panOffset.set(te[4], te[5], te[6]);
		panOffset.multiplyScalar(distance);

		pan.add(panOffset);
	};

	// pass in distance in world space to move forward
	this.panForward = function (distance) {

		if (this.track) {
			this.setTrackPos(this.getTrackPos() - distance / this.track.getLength());
		} else {
			var te = this.object.matrix.elements;

			// get Y column of matrix
			panOffset.set(te[8], te[9], te[10]);
			//panOffset.set( te[ 8 ], 0, te[ 10 ] );
			panOffset.multiplyScalar(distance);

			pan.add(panOffset);
		}
	};

	this.pan = function (deltaX, deltaY) {

		var element = scope.domElement === document ? scope.domElement.body : scope.domElement;

		if (scope.object.fov !== undefined) {
			// perspective
			var position = scope.object.position;
			var offset = position.clone();
			var targetDistance = offset.length();

			// half of the fov is center to top of screen
			targetDistance *= Math.tan(scope.object.fov / 2 * Math.PI / 180.0);

			// we actually don't use screenWidth, since perspective camera is fixed to screen height
			scope.panLeft(2 * deltaX * targetDistance / element.clientHeight);
			scope.panUp(2 * deltaY * targetDistance / element.clientHeight);
		} else if (scope.object.top !== undefined) {

			// orthographic
			scope.panLeft(deltaX * (scope.object.right - scope.object.left) / element.clientWidth);
			scope.panUp(deltaY * (scope.object.top - scope.object.bottom) / element.clientHeight);
		} else {

			// camera neither orthographic or perspective
			console.warn('WARNING: GeoControls.js encountered an unknown camera type - pan disabled.');
		}
	};

	this.update = function (delta) {
		this.object.rotation.order = 'ZYX';

		var object = this.object;

		this.object = new THREE.Object3D();
		this.object.position.copy(object.position);
		this.object.rotation.copy(object.rotation);
		this.object.updateMatrix();
		this.object.updateMatrixWorld();

		var position = this.object.position;

		if (delta !== undefined) {

			var multiplier = scope.shiftDown ? 4 : 1;
			if (this.moveRight) {
				this.panLeft(-delta * this.moveSpeed * multiplier);
			}
			if (this.moveLeft) {
				this.panLeft(delta * this.moveSpeed * multiplier);
			}
			if (this.moveForward || this.moveForwardMouse) {
				this.panForward(-delta * this.moveSpeed * multiplier);
			}
			if (this.moveBackward) {
				this.panForward(delta * this.moveSpeed * multiplier);
			}
			if (this.rotLeft) {
				scope.rotateLeft(-0.5 * Math.PI * delta / scope.rotateSpeed);
			}
			if (this.rotRight) {
				scope.rotateLeft(0.5 * Math.PI * delta / scope.rotateSpeed);
			}
			if (this.raiseCamera) {
				//scope.rotateUp( -0.5 * Math.PI * delta / scope.rotateSpeed );
				scope.panUp(delta * this.moveSpeed * multiplier);
			}
			if (this.lowerCamera) {
				//scope.rotateUp( 0.5 * Math.PI * delta / scope.rotateSpeed );
				scope.panUp(-delta * this.moveSpeed * multiplier);
			}
		}

		if (!pan.equals(new THREE.Vector3(0, 0, 0))) {
			var event = {
				type: 'move',
				translation: pan.clone()
			};
			this.dispatchEvent(event);
		}

		position.add(pan);

		if (!(thetaDelta === 0.0 && phiDelta === 0.0)) {
			var event = {
				type: 'rotate',
				thetaDelta: thetaDelta,
				phiDelta: phiDelta
			};
			this.dispatchEvent(event);
		}

		this.object.updateMatrix();
		var rot = new THREE.Matrix4().makeRotationY(thetaDelta);
		var res = new THREE.Matrix4().multiplyMatrices(rot, this.object.matrix);
		this.object.quaternion.setFromRotationMatrix(res);

		this.object.rotation.x += phiDelta;
		this.object.updateMatrixWorld();

		// send transformation proposal to listeners
		var proposeTransformEvent = {
			type: "proposeTransform",
			oldPosition: object.position,
			newPosition: this.object.position,
			objections: 0,
			counterProposals: []
		};
		this.dispatchEvent(proposeTransformEvent);

		// check some counter proposals if transformation wasn't accepted
		if (proposeTransformEvent.objections > 0) {
			if (proposeTransformEvent.counterProposals.length > 0) {
				var cp = proposeTransformEvent.counterProposals;
				this.object.position.copy(cp[0]);

				proposeTransformEvent.objections = 0;
				proposeTransformEvent.counterProposals = [];
			}
		}

		// apply transformation, if accepted
		if (proposeTransformEvent.objections > 0) {} else {
			object.position.copy(this.object.position);
		}

		object.rotation.copy(this.object.rotation);

		this.object = object;

		thetaDelta = 0;
		phiDelta = 0;
		scale = 1;
		pan.set(0, 0, 0);

		if (lastPosition.distanceTo(this.object.position) > 0) {
			this.dispatchEvent(changeEvent);

			lastPosition.copy(this.object.position);
		}

		if (this.track) {
			var pos = this.track.getPointAt(this.trackPos);
			object.position.copy(pos);
		}
	};

	this.reset = function () {
		state = STATE.NONE;

		this.object.position.copy(this.position0);
	};

	function onMouseDown(event) {
		if (scope.enabled === false) return;
		event.preventDefault();

		if (event.button === 0) {
			state = STATE.ROTATE;

			rotateStart.set(event.clientX, event.clientY);
		} else if (event.button === 1) {
			state = STATE.PAN;

			panStart.set(event.clientX, event.clientY);
		} else if (event.button === 2) {
			//state = STATE.PAN;
			//
			//panStart.set( event.clientX, event.clientY );
			scope.moveForwardMouse = true;
		}

		//scope.domElement.addEventListener( 'mousemove', onMouseMove, false );
		//scope.domElement.addEventListener( 'mouseup', onMouseUp, false );
		scope.dispatchEvent(startEvent);
	}

	function onMouseMove(event) {
		if (scope.enabled === false) return;

		event.preventDefault();

		var element = scope.domElement === document ? scope.domElement.body : scope.domElement;

		if (state === STATE.ROTATE) {
			rotateEnd.set(event.clientX, event.clientY);
			rotateDelta.subVectors(rotateEnd, rotateStart);

			// rotating across whole screen goes 360 degrees around
			scope.rotateLeft(2 * Math.PI * rotateDelta.x / element.clientWidth * scope.rotateSpeed);

			// rotating up and down along whole screen attempts to go 360, but limited to 180
			scope.rotateUp(2 * Math.PI * rotateDelta.y / element.clientHeight * scope.rotateSpeed);

			rotateStart.copy(rotateEnd);
		} else if (state === STATE.PAN) {
			panEnd.set(event.clientX, event.clientY);
			panDelta.subVectors(panEnd, panStart);
			//panDelta.multiplyScalar(this.moveSpeed).multiplyScalar(0.0001);
			panDelta.multiplyScalar(0.002).multiplyScalar(scope.moveSpeed);

			scope.pan(panDelta.x, panDelta.y);

			panStart.copy(panEnd);
		}
	}

	function onMouseUp(event) {
		if (scope.enabled === false) return;

		//console.log(event.which);

		if (event.button === 2) {
			scope.moveForwardMouse = false;
		} else {
			//scope.domElement.removeEventListener( 'mousemove', onMouseMove, false );
			//scope.domElement.removeEventListener( 'mouseup', onMouseUp, false );
			scope.dispatchEvent(endEvent);
			state = STATE.NONE;
		}
	}

	function onMouseWheel(event) {
		if (scope.enabled === false || scope.noZoom === true) return;

		event.preventDefault();

		var direction = event.detail < 0 || event.wheelDelta > 0 ? 1 : -1;
		var moveSpeed = scope.moveSpeed + scope.moveSpeed * 0.1 * direction;
		moveSpeed = Math.max(0.1, moveSpeed);

		scope.setMoveSpeed(moveSpeed);

		scope.dispatchEvent(startEvent);
		scope.dispatchEvent(endEvent);
	}

	this.setMoveSpeed = function (value) {
		if (scope.moveSpeed !== value) {
			scope.moveSpeed = value;
			scope.dispatchEvent({
				type: "move_speed_changed",
				controls: scope
			});
		}
	};

	function onKeyDown(event) {
		if (scope.enabled === false) return;

		scope.shiftDown = event.shiftKey;

		switch (event.keyCode) {
			case scope.keys.UP:
				scope.moveForward = true;break;
			case scope.keys.BOTTOM:
				scope.moveBackward = true;break;
			case scope.keys.LEFT:
				scope.moveLeft = true;break;
			case scope.keys.RIGHT:
				scope.moveRight = true;break;
			case scope.keys.W:
				scope.moveForward = true;break;
			case scope.keys.S:
				scope.moveBackward = true;break;
			case scope.keys.A:
				scope.moveLeft = true;break;
			case scope.keys.D:
				scope.moveRight = true;break;
			case scope.keys.Q:
				scope.rotLeft = true;break;
			case scope.keys.E:
				scope.rotRight = true;break;
			case scope.keys.R:
				scope.raiseCamera = true;break;
			case scope.keys.F:
				scope.lowerCamera = true;break;
		}
	}

	function onKeyUp(event) {

		scope.shiftDown = event.shiftKey;

		switch (event.keyCode) {
			case scope.keys.W:
				scope.moveForward = false;break;
			case scope.keys.S:
				scope.moveBackward = false;break;
			case scope.keys.A:
				scope.moveLeft = false;break;
			case scope.keys.D:
				scope.moveRight = false;break;
			case scope.keys.UP:
				scope.moveForward = false;break;
			case scope.keys.BOTTOM:
				scope.moveBackward = false;break;
			case scope.keys.LEFT:
				scope.moveLeft = false;break;
			case scope.keys.RIGHT:
				scope.moveRight = false;break;
			case scope.keys.Q:
				scope.rotLeft = false;break;
			case scope.keys.E:
				scope.rotRight = false;break;
			case scope.keys.R:
				scope.raiseCamera = false;break;
			case scope.keys.F:
				scope.lowerCamera = false;break;
		}
	}

	this.domElement.addEventListener('contextmenu', function (event) {
		event.preventDefault();
	}, false);
	this.domElement.addEventListener('mousedown', onMouseDown, false);
	this.domElement.addEventListener('mousewheel', onMouseWheel, false);
	this.domElement.addEventListener('DOMMouseScroll', onMouseWheel, false); // firefox

	scope.domElement.addEventListener('mousemove', onMouseMove, false);
	scope.domElement.addEventListener('mouseup', onMouseUp, false);

	if (this.domElement.tabIndex === -1) {
		this.domElement.tabIndex = 2222;
	}
	scope.domElement.addEventListener('keydown', onKeyDown, false);
	scope.domElement.addEventListener('keyup', onKeyUp, false);
};

Potree.GeoControls.prototype = Object.create(THREE.EventDispatcher.prototype);
'use strict';

/**
 * @author mschuetz / http://mschuetz.at/
 * @author qiao / https://github.com/qiao
 * @author mrdoob / http://mrdoob.com
 * @author alteredq / http://alteredqualia.com/
 * @author WestLangley / http://github.com/WestLangley
 * @author erich666 / http://erichaines.com
 */
// 
// Adapted from THREE.OrbitControls
//

Potree.OrbitControls = function (renderer) {

	this.renderer = renderer;
	this.domElement = renderer.domElement;

	// Set to false to disable this control
	this.enabled = true;

	this.scene = null;

	// Limits to how far you can dolly in and out
	this.minDistance = 0;
	this.maxDistance = Infinity;

	this.zoomSpeed = 1.0;
	this.rotateSpeed = 1.0;
	this.keyPanSpeed = 7.0; // pixels moved per arrow key push

	this.minimumJumpDistance = 0.2;
	this.jumpDistance = null;

	this.fadeFactor = 10;

	// How far you can orbit vertically, upper and lower limits.
	// Range is 0 to Math.PI radians.
	this.minPolarAngle = 0; // radians
	this.maxPolarAngle = Math.PI; // radians

	// The four arrow keys
	this.keys = { LEFT: 37, UP: 38, RIGHT: 39, BOTTOM: 40 };

	////////////
	// internals

	var scope = this;

	var EPS = 0.000001;

	var rotateStart = new THREE.Vector2();
	var rotateEnd = new THREE.Vector2();
	var rotateDelta = new THREE.Vector2();

	var panStart = new THREE.Vector2();
	var panEnd = new THREE.Vector2();
	var panOffset = new THREE.Vector3();

	var offset = new THREE.Vector3();

	var dollyStart = new THREE.Vector2();
	var dollyEnd = new THREE.Vector2();
	var dollyDelta = new THREE.Vector2();

	this.yawDelta = 0;
	this.pitchDelta = 0;
	this.panDelta = new THREE.Vector3();
	var scale = 1;

	var lastPosition = new THREE.Vector3();

	var STATE = { NONE: -1, ROTATE: 0, DOLLY: 1, PAN: 2, TOUCH_ROTATE: 3, TOUCH_DOLLY: 4, TOUCH_PAN: 5 };

	var state = STATE.NONE;

	// events

	var changeEvent = { type: 'change' };
	var startEvent = { type: 'start' };
	var endEvent = { type: 'end' };

	this.setScene = function (scene) {
		this.scene = scene;
	};

	this.rotateLeft = function (angle) {
		this.yawDelta -= angle;
	};

	this.rotateUp = function (angle) {
		this.pitchDelta -= angle;
	};

	this.dollyIn = function (dollyScale) {
		if (dollyScale === undefined) {
			dollyScale = getZoomScale();
		}

		scale /= dollyScale;
	};

	this.dollyOut = function (dollyScale) {
		if (dollyScale === undefined) {
			dollyScale = getZoomScale();
		}

		scale *= dollyScale;
	};

	this.update = function (delta) {
		var position = this.scene.view.position.clone();

		offset.copy(position).sub(this.scene.view.target);

		var yaw = Math.atan2(offset.x, offset.y);
		var pitch = Math.atan2(Math.sqrt(offset.x * offset.x + offset.y * offset.y), offset.z);

		var progression = Math.min(1, this.fadeFactor * delta);

		yaw -= progression * this.yawDelta;
		pitch += progression * this.pitchDelta;

		pitch = Math.max(this.minPolarAngle, Math.min(this.maxPolarAngle, pitch));
		pitch = Math.max(EPS, Math.min(Math.PI - EPS, pitch));

		var radius = offset.length();
		radius += (scale - 1) * radius * progression;

		// restrict radius to be between desired limits
		radius = Math.max(this.minDistance, Math.min(this.maxDistance, radius));

		// resolve pan
		var dir = new THREE.Vector3().subVectors(this.scene.view.target, this.scene.view.position).normalize();
		var up = new THREE.Vector3(0, 0, 1);
		var pdx = new THREE.Vector3().crossVectors(dir, up);
		var pdy = new THREE.Vector3().crossVectors(pdx, dir);
		var panr = new THREE.Vector3().addVectors(pdx.multiplyScalar(2 * this.panDelta.x / this.domElement.clientWidth), pdy.multiplyScalar(2 * this.panDelta.y / this.domElement.clientHeight));

		// move target to panned location
		var newTarget = this.scene.view.target.clone().add(panr.multiplyScalar(progression * radius));

		offset.x = radius * Math.sin(pitch) * Math.sin(yaw);
		offset.z = radius * Math.cos(pitch);
		offset.y = radius * Math.sin(pitch) * Math.cos(yaw);

		position.copy(newTarget).add(offset);

		// send transformation proposal to listeners
		var proposeTransformEvent = {
			type: "proposeTransform",
			oldPosition: this.scene.view.position,
			newPosition: position,
			objections: 0,
			counterProposals: []
		};
		this.dispatchEvent(proposeTransformEvent);

		// check some counter proposals if transformation wasn't accepted
		if (proposeTransformEvent.objections > 0) {

			if (proposeTransformEvent.counterProposals.length > 0) {
				var cp = proposeTransformEvent.counterProposals;
				position.copy(cp[0]);

				proposeTransformEvent.objections = 0;
				proposeTransformEvent.counterProposals = [];
			}
		}

		// apply transformation, if accepted
		if (proposeTransformEvent.objections > 0) {
			this.yawDelta = 0;
			this.pitchDelta = 0;
			scale = 1;
			this.panDelta.set(0, 0, 0);
		} else {
			this.scene.view.position.copy(position);
			this.scene.view.target.copy(newTarget);

			var attenuation = Math.max(0, 1 - this.fadeFactor * delta);

			this.yawDelta *= attenuation;
			this.pitchDelta *= attenuation;
			scale = 1 + (scale - 1) * attenuation;
			this.panDelta.multiplyScalar(attenuation);
		}

		if (lastPosition.distanceTo(this.scene.view.position) > 0) {
			this.dispatchEvent(changeEvent);

			lastPosition.copy(this.scene.view.position);
		}
	};

	function getZoomScale() {
		return Math.pow(0.95, scope.zoomSpeed);
	}

	function onMouseDown(event) {

		if (scope.enabled === false) return;
		event.preventDefault();

		if (event.button === THREE.MOUSE.LEFT) {
			state = STATE.ROTATE;

			rotateStart.set(event.clientX, event.clientY);
		} else if (event.button === THREE.MOUSE.MIDDLE) {
			state = STATE.DOLLY;

			dollyStart.set(event.clientX, event.clientY);
		} else if (event.button === THREE.MOUSE.RIGHT) {
			state = STATE.PAN;

			panStart.set(event.clientX, event.clientY);
		}

		scope.domElement.addEventListener('mousemove', onMouseMove, false);
		scope.domElement.addEventListener('mouseup', onMouseUp, false);
		scope.dispatchEvent(startEvent);
	}

	function onMouseMove(event) {
		if (scope.enabled === false) return;

		event.preventDefault();

		var element = scope.domElement === document ? scope.domElement.body : scope.domElement;

		if (state === STATE.ROTATE) {
			rotateEnd.set(event.clientX, event.clientY);
			rotateDelta.subVectors(rotateEnd, rotateStart);

			// rotating across whole screen goes 360 degrees around
			scope.rotateLeft(2 * Math.PI * rotateDelta.x / element.clientWidth * scope.rotateSpeed);

			// rotating up and down along whole screen attempts to go 360, but limited to 180
			scope.rotateUp(2 * Math.PI * rotateDelta.y / element.clientHeight * scope.rotateSpeed);

			rotateStart.copy(rotateEnd);
		} else if (state === STATE.DOLLY) {
			dollyEnd.set(event.clientX, event.clientY);
			dollyDelta.subVectors(dollyEnd, dollyStart);

			if (dollyDelta.y > 0) {

				scope.dollyIn();
			} else {

				scope.dollyOut();
			}

			dollyStart.copy(dollyEnd);
		} else if (state === STATE.PAN) {
			panEnd.set(event.clientX, event.clientY);
			var panDelta = new THREE.Vector2().subVectors(panEnd, panStart);

			scope.panDelta.x -= panDelta.x;
			scope.panDelta.y += panDelta.y;

			panStart.copy(panEnd);
		}
	}

	function onMouseUp() /* event */{
		if (scope.enabled === false) return;

		scope.domElement.removeEventListener('mousemove', onMouseMove, false);
		scope.domElement.removeEventListener('mouseup', onMouseUp, false);
		scope.dispatchEvent(endEvent);
		state = STATE.NONE;
	}

	function onMouseWheel(event) {
		if (scope.enabled === false) return;

		event.preventDefault();

		var delta = 0;

		if (event.wheelDelta !== undefined) {
			// WebKit / Opera / Explorer 9
			delta = event.wheelDelta;
		} else if (event.detail !== undefined) {
			// Firefox
			delta = -event.detail;
		}

		if (delta > 0) {
			scope.dollyOut();
		} else {
			scope.dollyIn();
		}

		scope.dispatchEvent(startEvent);
		scope.dispatchEvent(endEvent);
	}

	function onKeyDown(event) {
		if (scope.enabled === false) return;

		if (event.keyCode === scope.keys.UP) {
			scope.panDelta.y += scope.keyPanSpeed;
		} else if (event.keyCode === scope.keys.BOTTOM) {
			scope.panDelta.y -= scope.keyPanSpeed;
		} else if (event.keyCode === scope.keys.LEFT) {
			scope.panDelta.x -= scope.keyPanSpeed;
		} else if (event.keyCode === scope.keys.RIGHT) {
			scope.panDelta.x += scope.keyPanSpeed;
		}
	}

	this.domElement.addEventListener('contextmenu', function (event) {
		event.preventDefault();
	}, false);
	this.domElement.addEventListener('mousedown', onMouseDown, false);
	this.domElement.addEventListener('mousewheel', onMouseWheel, false);
	this.domElement.addEventListener('DOMMouseScroll', onMouseWheel, false); // firefox


	if (this.domElement.tabIndex === -1) {
		this.domElement.tabIndex = 2222;
	}
	this.domElement.addEventListener('keydown', onKeyDown, false);

	this.domElement.addEventListener("dblclick", function (event) {
		if (scope.scene.pointclouds.length === 0) {
			return;
		}

		event.preventDefault();

		var rect = scope.domElement.getBoundingClientRect();

		var mouse = {
			x: (event.clientX - rect.left) / scope.domElement.clientWidth * 2 - 1,
			y: -((event.clientY - rect.top) / scope.domElement.clientHeight) * 2 + 1
		};

		var pointcloud = null;
		var distance = Number.POSITIVE_INFINITY;
		var I = null;

		for (var i = 0; i < scope.scene.pointclouds.length; i++) {
			var intersection = Potree.utils.getMousePointCloudIntersection(mouse, scope.scene.camera, scope.renderer, [scope.scene.pointclouds[i]]);
			if (!intersection) {
				continue;
			}

			var tDist = scope.scene.camera.position.distanceTo(intersection);
			if (tDist < distance) {
				pointcloud = scope.scene.pointclouds[i];
				distance = tDist;
				I = intersection;
			}
		}

		if (I != null) {

			var targetRadius = 0;
			if (!scope.jumpDistance) {
				var camTargetDistance = scope.scene.camera.position.distanceTo(scope.scene.view.target);

				var vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
				vector.unproject(scope.scene.camera);

				var direction = vector.sub(scope.scene.camera.position).normalize();
				var ray = new THREE.Ray(scope.scene.camera.position, direction);

				var nodes = pointcloud.nodesOnRay(pointcloud.visibleNodes, ray);
				var lastNode = nodes[nodes.length - 1];
				var radius = lastNode.getBoundingSphere().radius;
				var targetRadius = Math.min(camTargetDistance, radius);
				var targetRadius = Math.max(scope.minimumJumpDistance, targetRadius);
			} else {
				targetRadius = scope.jumpDistance;
			}

			var d = scope.scene.camera.getWorldDirection().multiplyScalar(-1);
			var cameraTargetPosition = new THREE.Vector3().addVectors(I, d.multiplyScalar(targetRadius));
			var controlsTargetPosition = I;

			var animationDuration = 600;

			var easing = TWEEN.Easing.Quartic.Out;

			scope.enabled = false;

			// animate position
			var tween = new TWEEN.Tween(scope.scene.view.position).to(cameraTargetPosition, animationDuration);
			tween.easing(easing);
			tween.start();

			// animate target
			var tween = new TWEEN.Tween(scope.scene.view.target).to(I, animationDuration);
			tween.easing(easing);
			tween.onComplete(function () {
				scope.enabled = true;

				if (scope.moveSpeed) {
					scope.fpControls.moveSpeed = radius / 2;
					scope.geoControls.moveSpeed = radius / 2;
				}
			}.bind(this));
			tween.start();
		}
	}.bind(this));
};

Potree.OrbitControls.prototype = Object.create(THREE.EventDispatcher.prototype);
'use strict';

/**
 * @author mschuetz / http://mschuetz.at
 *
 *
 * Navigation similar to Google Earth.
 *
 * left mouse: Drag with respect to intersection
 * wheel: zoom towards/away from intersection
 * right mouse: Rotate camera around intersection
 *
 *
 */

THREE.EarthControls = function (camera, renderer, scene) {
	this.camera = camera;
	this.renderer = renderer;
	this.pointclouds = [];
	this.domElement = renderer.domElement;
	this.scene = scene;

	// Set to false to disable this control
	this.enabled = true;

	var scope = this;

	var STATE = { NONE: -1, DRAG: 0, ROTATE: 1 };

	var state = STATE.NONE;

	var dragStart = new THREE.Vector2();
	var dragEnd = new THREE.Vector2();

	var sphereGeometry = new THREE.SphereGeometry(1, 32, 32);
	var sphereMaterial = new THREE.MeshNormalMaterial({ shading: THREE.SmoothShading, transparent: true, opacity: 0.5 });
	this.pivotNode = new THREE.Mesh(sphereGeometry, sphereMaterial);

	var mouseDelta = new THREE.Vector2();

	var camStart = null;
	var pivot = null;

	var startEvent = { type: 'start' };
	var endEvent = { type: 'end' };

	this.minAngle = 10 / 180 * Math.PI; // 10°
	this.maxAngle = 70 / 180 * Math.PI; // 70°

	this.update = function (delta) {
		var position = this.camera.position;
		this.camera.updateMatrixWorld();

		var proposal = new THREE.Object3D();
		proposal.position.copy(this.camera.position);
		proposal.rotation.copy(this.camera.rotation);
		proposal.updateMatrix();
		proposal.updateMatrixWorld();

		if (pivot) {
			if (state === STATE.DRAG) {
				var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), pivot);
				var mouse = {
					x: dragEnd.x / this.domElement.clientWidth * 2 - 1,
					y: -(dragEnd.y / this.domElement.clientHeight) * 2 + 1
				};

				var vec = new THREE.Vector3(mouse.x, mouse.y, 0.5);
				vec.unproject(camStart);
				var dir = vec.sub(camStart.position).normalize();

				var ray = new THREE.Ray(camStart.position, dir);
				var distanceToPlane = ray.distanceToPlane(plane);

				if (distanceToPlane > 0) {
					var newCamPos = new THREE.Vector3().subVectors(pivot, dir.clone().multiplyScalar(distanceToPlane));
					proposal.position.copy(newCamPos);
				}
			} else if (state === STATE.ROTATE) {
				// rotate around pivot point

				var diff = mouseDelta.clone().multiplyScalar(delta);
				diff.x *= 0.3;
				diff.y *= -0.2;

				// do calculations on fresh nodes 
				var p = new THREE.Object3D();
				var c = new THREE.Object3D();
				p.add(c);
				p.position.copy(pivot);
				c.position.copy(this.camera.position).sub(pivot);
				c.rotation.copy(this.camera.rotation);

				// rotate left/right
				p.rotation.y += -diff.x;

				// rotate up/down
				var dir = this.camera.getWorldDirection();
				var up = new THREE.Vector3(0, 1, 0);
				var side = new THREE.Vector3().crossVectors(up, dir);

				var dirp = c.position.clone();
				dirp.y = 0;
				dirp.normalize();
				var ac = dirp.dot(c.position.clone().normalize());
				var angle = Math.acos(ac);
				if (c.position.y < 0) {
					angle = -angle;
				}

				var amount = 0;
				if (diff.y > 0) {
					// rotate downwards and apply minAngle limit
					amount = diff.y - Math.max(0, this.minAngle - (angle - diff.y));
				} else {
					// rotate upwards and apply maxAngle limit
					amount = diff.y + Math.max(0, angle - diff.y - this.maxAngle);
				}
				p.rotateOnAxis(side, -amount);

				// apply changes to object
				p.updateMatrixWorld();

				proposal.position.copy(c.getWorldPosition());
				proposal.quaternion.copy(c.getWorldQuaternion());
			}

			var proposeTransformEvent = {
				type: "proposeTransform",
				oldPosition: this.camera.position,
				newPosition: proposal.position,
				objections: 0
			};
			this.dispatchEvent(proposeTransformEvent);

			if (proposeTransformEvent.objections > 0) {} else {
				this.camera.position.copy(proposal.position);
				this.camera.rotation.copy(proposal.rotation);
			}

			var wp = this.pivotNode.getWorldPosition().applyMatrix4(this.camera.matrixWorldInverse);
			var w = Math.abs(wp.z / 30);
			var l = this.pivotNode.scale.length();
			this.pivotNode.scale.multiplyScalar(w / l);
		}

		mouseDelta.set(0, 0);
	};

	this.reset = function () {
		state = STATE.NONE;

		this.camera.position.copy(this.position0);
	};

	function onMouseDown(event) {
		if (scope.enabled === false) return;
		event.preventDefault();

		var rect = scope.domElement.getBoundingClientRect();

		var mouse = {
			x: (event.clientX - rect.left) / scope.domElement.clientWidth * 2 - 1,
			y: -((event.clientY - rect.top) / scope.domElement.clientHeight) * 2 + 1
		};
		var I = getMousePointCloudIntersection(mouse, scope.camera, scope.renderer, scope.pointclouds);
		if (!I) {
			return;
		}

		var plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), I);

		var vec = new THREE.Vector3(mouse.x, mouse.y, 0.5);
		vec.unproject(scope.camera);
		var dir = vec.sub(scope.camera.position).normalize();

		var ray = new THREE.Ray(scope.camera.position, dir);
		pivot = ray.intersectPlane(plane);

		//pivot = I;
		camStart = scope.camera.clone();
		camStart.rotation.copy(scope.camera.rotation);
		dragStart.set(event.clientX - rect.left, event.clientY - rect.top);
		dragEnd.set(event.clientX - rect.left, event.clientY - rect.top);

		scope.scene.add(scope.pivotNode);
		scope.pivotNode.position.copy(pivot);

		if (event.button === THREE.MOUSE.LEFT) {
			state = STATE.DRAG;
		} else if (event.button === THREE.MOUSE.RIGHT) {
			state = STATE.ROTATE;
		}

		scope.domElement.addEventListener('mousemove', onMouseMove, false);
		scope.domElement.addEventListener('mouseup', onMouseUp, false);
		scope.dispatchEvent(startEvent);
	}

	function onMouseMove(event) {
		if (scope.enabled === false) return;

		event.preventDefault();

		var rect = scope.domElement.getBoundingClientRect();

		var element = scope.domElement === document ? scope.domElement.body : scope.domElement;

		mouseDelta.set(event.clientX - rect.left - dragEnd.x, event.clientY - rect.top - dragEnd.y);
		dragEnd.set(event.clientX - rect.left, event.clientY - rect.top);
	}

	function onMouseUp() {
		if (scope.enabled === false) return;

		scope.domElement.removeEventListener('mousemove', onMouseMove, false);
		scope.domElement.removeEventListener('mouseup', onMouseUp, false);
		state = STATE.NONE;

		//scope.dragStartIndicator.style.display = "none";
		scope.scene.remove(scope.pivotNode);

		scope.dispatchEvent(endEvent);
	}

	function onMouseWheel(event) {
		if (scope.enabled === false || scope.noZoom === true) return;

		event.preventDefault();

		var rect = scope.domElement.getBoundingClientRect();

		var amount = event.detail < 0 || event.wheelDelta > 0 ? 1 : -1;
		var mouse = {
			x: (event.clientX - rect.left) / scope.domElement.clientWidth * 2 - 1,
			y: -((event.clientY - rect.top) / scope.domElement.clientHeight) * 2 + 1
		};
		var I = getMousePointCloudIntersection(mouse, scope.camera, scope.renderer, scope.pointclouds);

		if (I) {
			var distance = I.distanceTo(scope.camera.position);
			var dir = new THREE.Vector3().subVectors(I, scope.camera.position).normalize();
			scope.camera.position.add(dir.multiplyScalar(distance * 0.1 * amount));
		}

		scope.dispatchEvent(startEvent);
		scope.dispatchEvent(endEvent);
	}

	this.domElement.addEventListener('contextmenu', function (event) {
		event.preventDefault();
	}, false);
	this.domElement.addEventListener('mousedown', onMouseDown, false);
	this.domElement.addEventListener('mousewheel', onMouseWheel, false);
	this.domElement.addEventListener('DOMMouseScroll', onMouseWheel, false); // firefox
};

THREE.EarthControls.prototype = Object.create(THREE.EventDispatcher.prototype);
"use strict";

/**
 * 
 * @param node
 * @class an item in the lru list. 
 */
function LRUItem(node) {
	this.previous = null;
	this.next = null;
	this.node = node;
}

/**
 * 
 * @class A doubly-linked-list of the least recently used elements.
 */
function LRU() {
	// the least recently used item
	this.first = null;
	// the most recently used item
	this.last = null;
	// a list of all items in the lru list
	this.items = {};
	this.elements = 0;
	this.numPoints = 0;
}

/**
 * number of elements in the list
 * 
 * @returns {Number}
 */
LRU.prototype.size = function () {
	return this.elements;
};

LRU.prototype.contains = function (node) {
	return this.items[node.id] == null;
};

/**
 * makes node the most recently used item. if the list does not contain node, it will be added.
 * 
 * @param node
 */
LRU.prototype.touch = function (node) {
	if (!node.loaded) {
		return;
	}

	var item;
	if (this.items[node.id] == null) {
		// add to list
		item = new LRUItem(node);
		item.previous = this.last;
		this.last = item;
		if (item.previous !== null) {
			item.previous.next = item;
		}

		this.items[node.id] = item;
		this.elements++;

		if (this.first === null) {
			this.first = item;
		}
		this.numPoints += node.numPoints;
	} else {
		// update in list
		item = this.items[node.id];
		if (item.previous === null) {
			// handle touch on first element
			if (item.next !== null) {
				this.first = item.next;
				this.first.previous = null;
				item.previous = this.last;
				item.next = null;
				this.last = item;
				item.previous.next = item;
			}
		} else if (item.next === null) {
			// handle touch on last element
		} else {
			// handle touch on any other element
			item.previous.next = item.next;
			item.next.previous = item.previous;
			item.previous = this.last;
			item.next = null;
			this.last = item;
			item.previous.next = item;
		}
	}
};

///**
// * removes the least recently used item from the list and returns it. 
// * if the list was empty, null will be returned.
// */
//LRU.prototype.remove = function remove(){
//	if(this.first === null){
//		return null;
//	}
//	var lru = this.first;
//
//	// if the lru list contains at least 2 items, the item after the least recently used elemnt will be the new lru item. 
//	if(lru.next !== null){
//		this.first = lru.next;
//		this.first.previous = null;
//	}else{
//		this.first = null;
//		this.last = null;
//	}
//	
//	delete this.items[lru.node.id];
//	this.elements--;
//	this.numPoints -= lru.node.numPoints;
//	
////	Logger.info("removed node: " + lru.node.id);
//	return lru.node;
//};

LRU.prototype.remove = function remove(node) {

	var lruItem = this.items[node.id];
	if (lruItem) {

		if (this.elements === 1) {
			this.first = null;
			this.last = null;
		} else {
			if (!lruItem.previous) {
				this.first = lruItem.next;
				this.first.previous = null;
			}
			if (!lruItem.next) {
				this.last = lruItem.previous;
				this.last.next = null;
			}
			if (lruItem.previous && lruItem.next) {
				lruItem.previous.next = lruItem.next;
				lruItem.next.previous = lruItem.previous;
			}
		}

		delete this.items[node.id];
		this.elements--;
		this.numPoints -= node.numPoints;
	}
};

LRU.prototype.getLRUItem = function () {
	if (this.first === null) {
		return null;
	}
	var lru = this.first;

	return lru.node;
};

LRU.prototype.toString = function () {
	var string = "{ ";
	var curr = this.first;
	while (curr !== null) {
		string += curr.node.id;
		if (curr.next !== null) {
			string += ", ";
		}
		curr = curr.next;
	}
	string += "}";
	string += "(" + this.size() + ")";
	return string;
};

LRU.prototype.freeMemory = function () {
	if (this.elements <= 1) {
		return;
	}

	while (this.numPoints > Potree.pointLoadLimit) {
		var element = this.first;
		var node = element.node;
		this.disposeDescendants(node);
	}
};

LRU.prototype.disposeDescendants = function (node) {
	var stack = [];
	stack.push(node);
	while (stack.length > 0) {
		var current = stack.pop();

		//console.log(current);

		current.dispose();
		this.remove(current);

		for (var key in current.children) {
			if (current.children.hasOwnProperty(key)) {
				var child = current.children[key];
				if (child.loaded) {
					stack.push(current.children[key]);
				}
			}
		}
	}
};
"use strict";

Potree.Annotation = function (scene, args) {
	var _this = this;

	var scope = this;

	Potree.Annotation.counter++;

	this.scene = scene;
	this.ordinal = args.title || Potree.Annotation.counter;
	this.title = args.title || "No Title";
	this.description = args.description || "";
	this.position = args.position || new THREE.Vector3(0, 0, 0);
	this.cameraPosition = args.cameraPosition;
	this.cameraTarget = args.cameraTarget || this.position;
	this.view = args.view || null;
	this.keepOpen = false;
	this.descriptionVisible = false;
	this.actions = args.actions || null;
	this.appearance = args.appearance || null;

	this.domElement = document.createElement("div");
	this.domElement.style.position = "absolute";
	this.domElement.style.opacity = "0.5";
	this.domElement.style.padding = "10px";
	this.domElement.style.whiteSpace = "nowrap";
	this.domElement.className = "annotation";

	if (this.appearance !== null) {
		this.elOrdinal = document.createElement("div");
		this.elOrdinal.style.position = "relative";
		this.elOrdinal.style.zIndex = "100";
		this.elOrdinal.style.width = "fit-content";

		this.elOrdinal.innerHTML = this.appearance;
		this.domElement.appendChild(this.elOrdinal);
	} else {
		this.elOrdinal = document.createElement("div");
		this.elOrdinal.style.position = "relative";
		this.elOrdinal.style.color = "white";
		this.elOrdinal.style.backgroundColor = "black";
		this.elOrdinal.style.borderRadius = "1.5em";
		this.elOrdinal.style.fontSize = "1em";
		this.elOrdinal.style.opacity = "1";
		this.elOrdinal.style.margin = "auto";
		this.elOrdinal.style.zIndex = "100";
		this.elOrdinal.style.width = "fit-content";
		this.domElement.appendChild(this.elOrdinal);

		this.elOrdinalText = document.createElement("span");
		this.elOrdinalText.style.display = "inline-block";
		this.elOrdinalText.style.verticalAlign = "middle";
		this.elOrdinalText.style.lineHeight = "1.5em";
		this.elOrdinalText.style.textAlign = "center";
		this.elOrdinalText.style.fontFamily = "Arial";
		this.elOrdinalText.style.fontWeight = "bold";
		this.elOrdinalText.style.padding = "1px 8px 0px 8px";
		this.elOrdinalText.style.cursor = "default";
		this.elOrdinalText.innerHTML = this.ordinal;
		this.elOrdinalText.userSelect = "none";
		this.elOrdinal.appendChild(this.elOrdinalText);

		this.elOrdinal.onmouseenter = function () {};
		this.elOrdinal.onmouseleave = function () {};
		this.elOrdinalText.onclick = function () {
			scope.moveHere(scope.scene.camera);
			scope.dispatchEvent({ type: "click", target: scope });
		};
	}

	this.domDescription = document.createElement("div");
	this.domDescription.style.position = "relative";
	this.domDescription.style.color = "white";
	this.domDescription.style.backgroundColor = "black";
	this.domDescription.style.padding = "10px";
	this.domDescription.style.margin = "5px 0px 0px 0px";
	this.domDescription.style.borderRadius = "4px";
	this.domDescription.style.display = "none";
	this.domDescription.className = "annotation";
	this.domElement.appendChild(this.domDescription);

	if (this.actions != null) {
		this.elOrdinalText.style.padding = "1px 3px 0px 8px";

		var _iteratorNormalCompletion = true;
		var _didIteratorError = false;
		var _iteratorError = undefined;

		try {
			var _loop = function _loop() {
				var action = _step.value;

				var elButton = document.createElement("img");

				elButton.src = Potree.scriptPath + action.icon;
				elButton.style.width = "24px";
				elButton.style.height = "24px";
				elButton.style.filter = "invert(1)";
				elButton.style.display = "inline-block";
				elButton.style.verticalAlign = "middle";
				elButton.style.lineHeight = "1.5em";
				elButton.style.textAlign = "center";
				elButton.style.fontFamily = "Arial";
				elButton.style.fontWeight = "bold";
				elButton.style.padding = "1px 3px 0px 3px";
				elButton.style.cursor = "default";

				_this.elOrdinal.appendChild(elButton);

				elButton.onclick = function () {
					action.onclick();
				};
			};

			for (var _iterator = this.actions[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
				_loop();
			}
		} catch (err) {
			_didIteratorError = true;
			_iteratorError = err;
		} finally {
			try {
				if (!_iteratorNormalCompletion && _iterator.return) {
					_iterator.return();
				}
			} finally {
				if (_didIteratorError) {
					throw _iteratorError;
				}
			}
		}
	}

	this.elDescriptionText = document.createElement("span");
	this.elDescriptionText.style.color = "#ffffff";
	this.elDescriptionText.innerHTML = this.description;
	this.domDescription.appendChild(this.elDescriptionText);

	this.domElement.onmouseenter = function () {
		scope.domElement.style.opacity = "0.8";
		scope.domElement.style.zIndex = "1000";
		if (scope.description) {
			scope.descriptionVisible = true;
			scope.domDescription.style.display = "block";
		}
	};
	this.domElement.onmouseleave = function () {
		scope.domElement.style.opacity = "0.5";
		scope.domElement.style.zIndex = "100";
		scope.descriptionVisible = true;
		scope.domDescription.style.display = "none";
	};

	this.moveHere = function (camera) {
		var animationDuration = 800;
		var easing = TWEEN.Easing.Quartic.Out;

		// animate camera position
		var tween = new TWEEN.Tween(scope.scene.view.position).to(scope.cameraPosition, animationDuration);
		tween.easing(easing);
		tween.start();

		// animate camera target
		var camTargetDistance = camera.position.distanceTo(scope.cameraTarget);
		var target = new THREE.Vector3().addVectors(camera.position, camera.getWorldDirection().clone().multiplyScalar(camTargetDistance));
		var tween = new TWEEN.Tween(target).to(scope.cameraTarget, animationDuration);
		tween.easing(easing);
		tween.onUpdate(function () {
			//camera.lookAt(target);
			scope.scene.view.target.copy(target);
		});
		tween.onComplete(function () {
			//camera.lookAt(target);
			scope.scene.view.target.copy(target);
			scope.dispatchEvent({ type: "focusing_finished", target: scope });
		});

		scope.dispatchEvent({ type: "focusing_started", target: scope });
		tween.start();
	};

	this.dispose = function () {

		if (this.domElement.parentElement) {
			this.domElement.parentElement.removeChild(this.domElement);
		}
	};
};

Potree.Annotation.prototype = Object.create(THREE.EventDispatcher.prototype);

Potree.Annotation.counter = 0;
"use strict";

Potree.ProfileData = function (profile) {
	this.profile = profile;

	this.segments = [];
	this.boundingBox = new THREE.Box3();
	this.projectedBoundingBox = new THREE.Box2();

	var mileage = new THREE.Vector3();
	for (var i = 0; i < profile.points.length - 1; i++) {
		var start = profile.points[i];
		var end = profile.points[i + 1];

		var startGround = new THREE.Vector3(start.x, start.y, 0);
		var endGround = new THREE.Vector3(end.x, end.y, 0);

		var center = new THREE.Vector3().addVectors(endGround, startGround).multiplyScalar(0.5);
		var length = startGround.distanceTo(endGround);
		var side = new THREE.Vector3().subVectors(endGround, startGround).normalize();
		var up = new THREE.Vector3(0, 0, 1);
		var forward = new THREE.Vector3().crossVectors(side, up).normalize();
		var N = forward;
		var cutPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(N, startGround);
		var halfPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(side, center);

		var project = function (_start, _end, _mileage) {
			var start = _start;
			var end = _end;
			var mileage = _mileage;

			var xAxis = new THREE.Vector3(1, 0, 0);
			var dir = new THREE.Vector3().subVectors(end, start);
			dir.z = 0;
			dir.normalize();
			var alpha = Math.acos(xAxis.dot(dir));
			if (dir.y > 0) {
				alpha = -alpha;
			}

			return function (position) {
				var toOrigin = new THREE.Matrix4().makeTranslation(-start.x, -start.y, 0);
				var alignWithX = new THREE.Matrix4().makeRotationZ(-alpha);
				var applyMileage = new THREE.Matrix4().makeTranslation(mileage.x, 0, 0);

				var pos = position.clone();
				pos.applyMatrix4(toOrigin);
				pos.applyMatrix4(alignWithX);
				pos.applyMatrix4(applyMileage);

				return pos;
			};
		}(start, end, mileage.clone());

		var segment = {
			start: start,
			end: end,
			cutPlane: cutPlane,
			halfPlane: halfPlane,
			length: length,
			points: null,
			project: project
		};

		this.segments.push(segment);

		mileage.x += length;
		mileage.z += end.z - start.z;
	}

	this.projectedBoundingBox.min.x = 0;
	this.projectedBoundingBox.min.z = Number.POSITIVE_INFINITY;
	this.projectedBoundingBox.max.x = mileage.x;
	this.projectedBoundingBox.max.z = Number.NEGATIVE_INFINITY;

	this.size = function () {
		var size = 0;
		for (var i = 0; i < this.segments.length; i++) {
			if (this.segments[i].points) {
				size += this.segments[i].points.numPoints;
			}
		}
		return size;
	};
};

Potree.ProfileRequest = function (pointcloud, profile, maxDepth, callback) {

	this.pointcloud = pointcloud;
	this.profile = profile;
	this.maxDepth = maxDepth || Number.MAX_VALUE;
	this.callback = callback;
	this.temporaryResult = new Potree.ProfileData(this.profile);
	this.pointsServed = 0;

	this.priorityQueue = new BinaryHeap(function (x) {
		return 1 / x.weight;
	});

	this.initialize = function () {
		this.priorityQueue.push({ node: pointcloud.pcoGeometry.root, weight: 1 });
		this.traverse(pointcloud.pcoGeometry.root);
	};

	// traverse the node and add intersecting descendants to queue
	this.traverse = function (node) {

		var stack = [];
		for (var i = 0; i < 8; i++) {
			var child = node.children[i];
			if (child && pointcloud.nodeIntersectsProfile(child, this.profile)) {
				stack.push(child);
			}
		}

		while (stack.length > 0) {
			var node = stack.pop();
			var weight = node.boundingSphere.radius;

			this.priorityQueue.push({ node: node, weight: weight });

			// add children that intersect the cutting plane
			if (node.level < this.maxDepth) {
				for (var i = 0; i < 8; i++) {
					var child = node.children[i];
					if (child && pointcloud.nodeIntersectsProfile(child, this.profile)) {
						stack.push(child);
					}
				}
			}
		}
	};

	this.update = function () {

		// load nodes in queue
		// if hierarchy expands, also load nodes from expanded hierarchy
		// once loaded, add data to this.points and remove node from queue
		// only evaluate 1-50 nodes per frame to maintain responsiveness

		var intersectedNodes = [];

		for (var i = 0; i < Math.min(2, this.priorityQueue.size()); i++) {
			var element = this.priorityQueue.pop();
			var node = element.node;

			if (node.loaded) {
				// add points to result
				intersectedNodes.push(node);
				Potree.getLRU().touch(node);

				if (node.level % node.pcoGeometry.hierarchyStepSize === 0 && node.hasChildren) {
					this.traverse(node);
				}
			} else {
				node.load();
				this.priorityQueue.push(element);
			}
		}

		if (intersectedNodes.length > 0) {
			this.getPointsInsideProfile(intersectedNodes, this.temporaryResult);
			if (this.temporaryResult.size() > 100) {
				this.pointsServed += this.temporaryResult.size();
				callback.onProgress({ request: this, points: this.temporaryResult });
				this.temporaryResult = new Potree.ProfileData(this.profile);
			}
		}

		if (this.priorityQueue.size() === 0) {
			// we're done! inform callback and remove from pending requests

			if (this.temporaryResult.size() > 0) {
				this.pointsServed += this.temporaryResult.size();
				callback.onProgress({ request: this, points: this.temporaryResult });
				this.temporaryResult = new Potree.ProfileData(this.profile);
			}

			callback.onFinish({ request: this });

			var index = pointcloud.profileRequests.indexOf(this);
			if (index >= 0) {
				pointcloud.profileRequests.splice(index, 1);
			}
		}
	};

	this.getPointsInsideProfile = function (nodes, target) {

		for (var pi = 0; pi < target.segments.length; pi++) {
			var segment = target.segments[pi];

			for (var ni = 0; ni < nodes.length; ni++) {
				var node = nodes[ni];

				var geometry = node.geometry;
				var positions = geometry.attributes.position;
				var p = positions.array;
				var numPoints = node.numPoints;

				if (!segment.points) {
					segment.points = {};
					segment.points.boundingBox = new THREE.Box3();

					for (var property in geometry.attributes) {
						if (geometry.attributes.hasOwnProperty(property)) {
							if (property === "indices") {} else {
								segment.points[property] = [];
							}
						}
					}
				}

				for (var i = 0; i < numPoints; i++) {
					var pos = new THREE.Vector3(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
					pos.applyMatrix4(pointcloud.matrixWorld);
					var distance = Math.abs(segment.cutPlane.distanceToPoint(pos));
					var centerDistance = Math.abs(segment.halfPlane.distanceToPoint(pos));

					if (distance < profile.width / 2 && centerDistance < segment.length / 2) {
						segment.points.boundingBox.expandByPoint(pos);

						for (var property in geometry.attributes) {
							if (geometry.attributes.hasOwnProperty(property)) {

								if (property === "position") {
									segment.points[property].push(pos);
								} else if (property === "indices") {
									// skip indices
								} else {
									var values = geometry.attributes[property];
									if (values.itemSize === 1) {
										segment.points[property].push(values.array[i]);
									} else {
										var value = [];
										for (var j = 0; j < values.itemSize; j++) {
											value.push(values.array[i * values.itemSize + j]);
										}
										segment.points[property].push(value);
									}
								}
							}
						}
					} else {
						var a;
					}
				}
			}

			segment.points.numPoints = segment.points.position.length;

			if (segment.points.numPoints > 0) {
				target.boundingBox.expandByPoint(segment.points.boundingBox.min);
				target.boundingBox.expandByPoint(segment.points.boundingBox.max);

				target.projectedBoundingBox.expandByPoint(new THREE.Vector2(0, target.boundingBox.min.y));
				target.projectedBoundingBox.expandByPoint(new THREE.Vector2(0, target.boundingBox.max.y));
			}
		}
	};

	this.cancel = function () {
		callback.onCancel();

		this.priorityQueue = new BinaryHeap(function (x) {
			return 1 / x.weight;
		});

		var index = pointcloud.profileRequests.indexOf(this);
		if (index >= 0) {
			pointcloud.profileRequests.splice(index, 1);
		}
	};

	this.initialize();
};

Potree.PointCloudOctreeNode = function () {
	this.children = {};
	this.sceneNode = null;
	this.octree = null;

	this.getNumPoints = function () {
		return this.geometryNode.numPoints;
	};

	this.isLoaded = function () {
		return true;
	};

	this.isTreeNode = function () {
		return true;
	};

	this.isGeometryNode = function () {
		return false;
	};

	this.getLevel = function () {
		return this.geometryNode.level;
	};

	this.getBoundingSphere = function () {
		return this.geometryNode.boundingSphere;
	};

	this.getBoundingBox = function () {
		return this.geometryNode.boundingBox;
	};

	this.getChildren = function () {
		var children = [];

		for (var i = 0; i < 8; i++) {
			if (this.children[i]) {
				children.push(this.children[i]);
			}
		}

		return children;
	};
};

Potree.PointCloudOctreeNode.prototype = Object.create(Potree.PointCloudTreeNode.prototype);

Potree.PointCloudOctree = function (geometry, material) {
	//THREE.Object3D.call( this );
	Potree.PointCloudTree.call(this);

	this.pcoGeometry = geometry;
	this.boundingBox = this.pcoGeometry.tightBoundingBox;
	this.boundingSphere = this.boundingBox.getBoundingSphere();
	this.material = material || new Potree.PointCloudMaterial();
	this.visiblePointsTarget = 2 * 1000 * 1000;
	this.minimumNodePixelSize = 150;
	this.level = 0;
	this.position.sub(geometry.offset);
	this.updateMatrix();

	this.showBoundingBox = false;
	this.boundingBoxNodes = [];
	this.loadQueue = [];
	this.visibleBounds = new THREE.Box3();
	this.visibleNodes = [];
	this.visibleGeometry = [];
	this.pickTarget = null;
	this.generateDEM = false;
	this.profileRequests = [];
	this.name = "";

	// TODO read projection from file instead
	this.projection = geometry.projection;

	this.root = this.pcoGeometry.root;
};

Potree.PointCloudOctree.prototype = Object.create(Potree.PointCloudTree.prototype);

Potree.PointCloudOctree.prototype.setName = function (name) {
	if (this.name !== name) {
		this.name = name;
		this.dispatchEvent({ type: "name_changed", name: name, pointcloud: this });
	}
};

Potree.PointCloudOctree.prototype.getName = function () {
	return this.name;
};

Potree.PointCloudOctree.prototype.toTreeNode = function (geometryNode, parent) {
	var node = new Potree.PointCloudOctreeNode();
	var sceneNode = new THREE.Points(geometryNode.geometry, this.material);

	node.geometryNode = geometryNode;
	node.sceneNode = sceneNode;
	node.pointcloud = this;
	node.children = {};
	for (var key in geometryNode.children) {
		node.children[key] = geometryNode.children[key];
	}

	if (!parent) {
		this.root = node;
		this.add(sceneNode);
	} else {
		var childIndex = parseInt(geometryNode.name[geometryNode.name.length - 1]);
		parent.sceneNode.add(sceneNode);
		parent.children[childIndex] = node;
	}

	var disposeListener = function disposeListener() {
		var childIndex = parseInt(geometryNode.name[geometryNode.name.length - 1]);
		parent.sceneNode.remove(node.sceneNode);
		parent.children[childIndex] = geometryNode;
	};
	geometryNode.oneTimeDisposeHandlers.push(disposeListener);

	return node;
};

Potree.PointCloudOctree.prototype.updateVisibleBounds = function () {

	var leafNodes = [];
	for (var i = 0; i < this.visibleNodes.length; i++) {
		var node = this.visibleNodes[i];
		var isLeaf = true;

		for (var j = 0; j < node.children.length; j++) {
			var child = node.children[j];
			if (child instanceof Potree.PointCloudOctreeNode) {
				isLeaf = isLeaf && !child.sceneNode.visible;
			} else if (child instanceof Potree.PointCloudOctreeGeometryNode) {
				isLeaf = true;
			}
		}

		if (isLeaf) {
			leafNodes.push(node);
		}
	}

	this.visibleBounds.min = new THREE.Vector3(Infinity, Infinity, Infinity);
	this.visibleBounds.max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
	for (var i = 0; i < leafNodes.length; i++) {
		var node = leafNodes[i];

		this.visibleBounds.expandByPoint(node.getBoundingBox().min);
		this.visibleBounds.expandByPoint(node.getBoundingBox().max);
	}
};

Potree.PointCloudOctree.prototype.updateMaterial = function (material, visibleNodes, camera, renderer) {
	material.fov = camera.fov * (Math.PI / 180);
	material.screenWidth = renderer.domElement.clientWidth;
	material.screenHeight = renderer.domElement.clientHeight;
	material.spacing = this.pcoGeometry.spacing;
	material.near = camera.near;
	material.far = camera.far;
	material.uniforms.octreeSize.value = this.pcoGeometry.boundingBox.getSize().x;

	// update visibility texture
	if (material.pointSizeType >= 0) {
		if (material.pointSizeType === Potree.PointSizeType.ADAPTIVE || material.pointColorType === Potree.PointColorType.LOD) {

			this.updateVisibilityTexture(material, visibleNodes);
		}
	}
};

Potree.PointCloudOctree.prototype.updateVisibilityTexture = function (material, visibleNodes) {

	if (!material) {
		return;
	}

	var texture = material.visibleNodesTexture;
	var data = texture.image.data;

	// copy array
	visibleNodes = visibleNodes.slice();

	// sort by level and index, e.g. r, r0, r3, r4, r01, r07, r30, ...
	var sort = function sort(a, b) {
		var na = a.geometryNode.name;
		var nb = b.geometryNode.name;
		if (na.length != nb.length) return na.length - nb.length;
		if (na < nb) return -1;
		if (na > nb) return 1;
		return 0;
	};
	visibleNodes.sort(sort);

	for (var i = 0; i < visibleNodes.length; i++) {
		var node = visibleNodes[i];

		var children = [];
		for (var j = 0; j < 8; j++) {
			var child = node.children[j];
			if (child instanceof Potree.PointCloudOctreeNode && child.sceneNode.visible && visibleNodes.indexOf(child) >= 0) {
				children.push(child);
			}
		}
		children.sort(function (a, b) {
			if (a.geometryNode.name < b.geometryNode.name) return -1;
			if (a.geometryNode.name > b.geometryNode.name) return 1;
			return 0;
		});

		data[i * 3 + 0] = 0;
		data[i * 3 + 1] = 0;
		data[i * 3 + 2] = 0;
		for (var j = 0; j < children.length; j++) {
			var child = children[j];
			var index = parseInt(child.geometryNode.name.substr(-1));
			data[i * 3 + 0] += Math.pow(2, index);

			if (j === 0) {
				var vArrayIndex = visibleNodes.indexOf(child);
				data[i * 3 + 1] = vArrayIndex - i;
			}
		}
	}

	texture.needsUpdate = true;
};

Potree.PointCloudOctree.prototype.nodeIntersectsProfile = function (node, profile) {
	var bbWorld = node.boundingBox.clone().applyMatrix4(this.matrixWorld);
	var bsWorld = bbWorld.getBoundingSphere();

	for (var i = 0; i < profile.points.length - 1; i++) {
		var start = new THREE.Vector3(profile.points[i].x, bsWorld.center.y, profile.points[i].z);
		var end = new THREE.Vector3(profile.points[i + 1].x, bsWorld.center.y, profile.points[i + 1].z);

		var ray1 = new THREE.Ray(start, new THREE.Vector3().subVectors(end, start).normalize());
		var ray2 = new THREE.Ray(end, new THREE.Vector3().subVectors(start, end).normalize());

		if (ray1.intersectsSphere(bsWorld) && ray2.intersectsSphere(bsWorld)) {
			return true;
		}
	}

	return false;
};

Potree.PointCloudOctree.prototype.nodesOnRay = function (nodes, ray) {
	var nodesOnRay = [];

	var _ray = ray.clone();
	for (var i = 0; i < nodes.length; i++) {
		var node = nodes[i];
		//var inverseWorld = new THREE.Matrix4().getInverse(node.matrixWorld);
		var sphere = node.getBoundingSphere().clone().applyMatrix4(node.sceneNode.matrixWorld);

		if (_ray.intersectsSphere(sphere)) {
			nodesOnRay.push(node);
		}
	}

	return nodesOnRay;
};

Potree.PointCloudOctree.prototype.updateMatrixWorld = function (force) {
	//node.matrixWorld.multiplyMatrices( node.parent.matrixWorld, node.matrix );

	if (this.matrixAutoUpdate === true) this.updateMatrix();

	if (this.matrixWorldNeedsUpdate === true || force === true) {

		if (this.parent === undefined) {

			this.matrixWorld.copy(this.matrix);
		} else {

			this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
		}

		this.matrixWorldNeedsUpdate = false;

		force = true;
	}
};

Potree.PointCloudOctree.prototype.hideDescendants = function (object) {
	var stack = [];
	for (var i = 0; i < object.children.length; i++) {
		var child = object.children[i];
		if (child.visible) {
			stack.push(child);
		}
	}

	while (stack.length > 0) {
		var object = stack.shift();

		object.visible = false;

		for (var i = 0; i < object.children.length; i++) {
			var child = object.children[i];
			if (child.visible) {
				stack.push(child);
			}
		}
	}
};

Potree.PointCloudOctree.prototype.moveToOrigin = function () {
	this.position.set(0, 0, 0);
	this.updateMatrixWorld(true);
	var box = this.boundingBox;
	var transform = this.matrixWorld;
	var tBox = Potree.utils.computeTransformedBoundingBox(box, transform);
	this.position.set(0, 0, 0).sub(tBox.getCenter());
};

Potree.PointCloudOctree.prototype.moveToGroundPlane = function () {
	this.updateMatrixWorld(true);
	var box = this.boundingBox;
	var transform = this.matrixWorld;
	var tBox = Potree.utils.computeTransformedBoundingBox(box, transform);
	this.position.y += -tBox.min.y;
};

Potree.PointCloudOctree.prototype.getBoundingBoxWorld = function () {
	this.updateMatrixWorld(true);
	var box = this.boundingBox;
	var transform = this.matrixWorld;
	var tBox = Potree.utils.computeTransformedBoundingBox(box, transform);

	return tBox;
};

/**
 * returns points inside the profile points
 *
 * maxDepth:		search points up to the given octree depth
 *
 *
 * The return value is an array with all segments of the profile path
 *  var segment = {
 * 		start: 	THREE.Vector3,
 * 		end: 	THREE.Vector3,
 * 		points: {}
 * 		project: function()
 *  };
 *
 * The project() function inside each segment can be used to transform
 * that segments point coordinates to line up along the x-axis.
 *
 *
 */
Potree.PointCloudOctree.prototype.getPointsInProfile = function (profile, maxDepth, callback) {

	if (callback) {
		var request = new Potree.ProfileRequest(this, profile, maxDepth, callback);
		this.profileRequests.push(request);

		return request;
	}

	var points = {
		segments: [],
		boundingBox: new THREE.Box3(),
		projectedBoundingBox: new THREE.Box2()
	};

	// evaluate segments
	for (var i = 0; i < profile.points.length - 1; i++) {
		var start = profile.points[i];
		var end = profile.points[i + 1];
		var ps = this.getProfile(start, end, profile.width, maxDepth);

		var segment = {
			start: start,
			end: end,
			points: ps,
			project: null
		};

		points.segments.push(segment);

		points.boundingBox.expandByPoint(ps.boundingBox.min);
		points.boundingBox.expandByPoint(ps.boundingBox.max);
	}

	// add projection functions to the segments
	var mileage = new THREE.Vector3();
	for (var i = 0; i < points.segments.length; i++) {
		var segment = points.segments[i];
		var start = segment.start;
		var end = segment.end;

		var project = function (_start, _end, _mileage, _boundingBox) {
			var start = _start;
			var end = _end;
			var mileage = _mileage;
			var boundingBox = _boundingBox;

			var xAxis = new THREE.Vector3(1, 0, 0);
			var dir = new THREE.Vector3().subVectors(end, start);
			dir.y = 0;
			dir.normalize();
			var alpha = Math.acos(xAxis.dot(dir));
			if (dir.z > 0) {
				alpha = -alpha;
			}

			return function (position) {

				var toOrigin = new THREE.Matrix4().makeTranslation(-start.x, -boundingBox.min.y, -start.z);
				var alignWithX = new THREE.Matrix4().makeRotationY(-alpha);
				var applyMileage = new THREE.Matrix4().makeTranslation(mileage.x, 0, 0);

				var pos = position.clone();
				pos.applyMatrix4(toOrigin);
				pos.applyMatrix4(alignWithX);
				pos.applyMatrix4(applyMileage);

				return pos;
			};
		}(start, end, mileage.clone(), points.boundingBox.clone());

		segment.project = project;

		mileage.x += new THREE.Vector3(start.x, 0, start.z).distanceTo(new THREE.Vector3(end.x, 0, end.z));
		mileage.y += end.y - start.y;
	}

	points.projectedBoundingBox.min.x = 0;
	points.projectedBoundingBox.min.y = points.boundingBox.min.y;
	points.projectedBoundingBox.max.x = mileage.x;
	points.projectedBoundingBox.max.y = points.boundingBox.max.y;

	return points;
};

/**
 * returns points inside the given profile bounds.
 *
 * start: 	
 * end: 	
 * width:	
 * depth:		search points up to the given octree depth
 * callback:	if specified, points are loaded before searching
 *				
 *
 */
Potree.PointCloudOctree.prototype.getProfile = function (start, end, width, depth, callback) {
	if (callback !== undefined) {
		var request = new Potree.ProfileRequest(start, end, width, depth, callback);
		this.profileRequests.push(request);
	} else {
		var stack = [];
		stack.push(this);

		var center = new THREE.Vector3().addVectors(end, start).multiplyScalar(0.5);
		var length = new THREE.Vector3().subVectors(end, start).length();
		var side = new THREE.Vector3().subVectors(end, start).normalize();
		var up = new THREE.Vector3(0, 1, 0);
		var forward = new THREE.Vector3().crossVectors(side, up).normalize();
		var N = forward;
		var cutPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(N, start);
		var halfPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(side, center);

		var inside = null;

		var boundingBox = new THREE.Box3();

		while (stack.length > 0) {
			var object = stack.shift();

			var pointsFound = 0;

			if (object instanceof THREE.Points) {
				var geometry = object.geometry;
				var positions = geometry.attributes.position;
				var p = positions.array;
				var numPoints = object.numPoints;

				if (!inside) {
					inside = {};

					for (var property in geometry.attributes) {
						if (geometry.attributes.hasOwnProperty(property)) {
							if (property === "indices") {} else {
								inside[property] = [];
							}
						}
					}
				}

				for (var i = 0; i < numPoints; i++) {
					var pos = new THREE.Vector3(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
					pos.applyMatrix4(this.matrixWorld);
					var distance = Math.abs(cutPlane.distanceToPoint(pos));
					var centerDistance = Math.abs(halfPlane.distanceToPoint(pos));

					if (distance < width / 2 && centerDistance < length / 2) {
						boundingBox.expandByPoint(pos);

						for (var property in geometry.attributes) {
							if (geometry.attributes.hasOwnProperty(property)) {

								if (property === "position") {
									inside[property].push(pos);
								} else if (property === "indices") {
									// skip indices
								} else {
									var values = geometry.attributes[property];
									if (values.itemSize === 1) {
										inside[property].push(values.array[i + j]);
									} else {
										var value = [];
										for (var j = 0; j < values.itemSize; j++) {
											value.push(values.array[i * values.itemSize + j]);
										}
										inside[property].push(value);
									}
								}
							}
						}

						pointsFound++;
					}
				}
			}

			//console.log("traversing: " + object.name + ", #points found: " + pointsFound);

			if (object == this || object.level < depth) {
				for (var i = 0; i < object.children.length; i++) {
					var child = object.children[i];
					if (child instanceof THREE.Points) {
						var sphere = child.boundingSphere.clone().applyMatrix4(child.matrixWorld);
						if (cutPlane.distanceToSphere(sphere) < sphere.radius) {
							stack.push(child);
						}
					}
				}
			}
		}

		inside.numPoints = inside.position.length;

		var project = function (_start, _end) {
			var start = _start;
			var end = _end;

			var xAxis = new THREE.Vector3(1, 0, 0);
			var dir = new THREE.Vector3().subVectors(end, start);
			dir.y = 0;
			dir.normalize();
			var alpha = Math.acos(xAxis.dot(dir));
			if (dir.z > 0) {
				alpha = -alpha;
			}

			return function (position) {

				var toOrigin = new THREE.Matrix4().makeTranslation(-start.x, -start.y, -start.z);
				var alignWithX = new THREE.Matrix4().makeRotationY(-alpha);

				var pos = position.clone();
				pos.applyMatrix4(toOrigin);
				pos.applyMatrix4(alignWithX);

				return pos;
			};
		}(start, end);

		inside.project = project;
		inside.boundingBox = boundingBox;

		return inside;
	}
};

Potree.PointCloudOctree.prototype.getVisibleExtent = function () {
	return this.visibleBounds.applyMatrix4(this.matrixWorld);
};

/**
 *
 *
 *
 * params.pickWindowSize:	Look for points inside a pixel window of this size.
 * 							Use odd values: 1, 3, 5, ...
 * 
 * 
 * TODO: only draw pixels that are actually read with readPixels(). 
 * 
 */
Potree.PointCloudOctree.prototype.pick = function (renderer, camera, ray, params) {
	// this function finds intersections by rendering point indices and then checking the point index at the mouse location.
	// point indices are 3 byte and rendered to the RGB component.
	// point cloud node indices are 1 byte and stored in the ALPHA component.
	// this limits picking capabilities to 256 nodes and 2^24 points per node. 

	var gl = renderer.context;

	var compileMaterial = function compileMaterial(material) {
		if (material._glstate === undefined) {
			material._glstate = {};
		}

		var glstate = material._glstate;

		// VERTEX SHADER
		var vs = gl.createShader(gl.VERTEX_SHADER);
		{
			gl.shaderSource(vs, material.vertexShader);
			gl.compileShader(vs);

			var _success = gl.getShaderParameter(vs, gl.COMPILE_STATUS);
			if (!_success) {
				console.error("could not compile vertex shader:");

				var log = gl.getShaderInfoLog(vs);
				console.error(log, material.vertexShader);

				return;
			}
		}

		// FRAGMENT SHADER
		var fs = gl.createShader(gl.FRAGMENT_SHADER);
		{
			gl.shaderSource(fs, material.fragmentShader);
			gl.compileShader(fs);

			var _success2 = gl.getShaderParameter(fs, gl.COMPILE_STATUS);
			if (!_success2) {
				console.error("could not compile fragment shader:");
				console.error(material.fragmentShader);

				return;
			}
		}

		// PROGRAM
		var program = gl.createProgram();
		gl.attachShader(program, vs);
		gl.attachShader(program, fs);
		gl.linkProgram(program);
		var success = gl.getProgramParameter(program, gl.LINK_STATUS);
		if (!success) {
			console.error("could not compile shader:");
			console.error(material.vertexShader);
			console.error(material.fragmentShader);

			return;
		}

		glstate.program = program;

		gl.useProgram(program);

		{
			// UNIFORMS
			var _uniforms = {};
			var n = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);

			for (var i = 0; i < n; i++) {
				var uniform = gl.getActiveUniform(program, i);
				var name = uniform.name;
				var loc = gl.getUniformLocation(program, name);

				_uniforms[name] = loc;
			}

			glstate.uniforms = _uniforms;
			glstate.textures = {};
		}
	};

	if (Potree.PointCloudOctree.pickMaterial === undefined) {
		Potree.PointCloudOctree.pickMaterial = new Potree.PointCloudMaterial();
		Potree.PointCloudOctree.pickMaterial.pointColorType = Potree.PointColorType.POINT_INDEX;
		//Potree.PointCloudOctree.pickMaterial.pointColorType = Potree.PointColorType.COLOR;

		compileMaterial(Potree.PointCloudOctree.pickMaterial);
	}

	var pickMaterial = Potree.PointCloudOctree.pickMaterial;

	var params = params || {};
	var pickWindowSize = params.pickWindowSize || 17;
	var pickOutsideClipRegion = params.pickOutsideClipRegion || false;

	var nodes = this.nodesOnRay(this.visibleNodes, ray);

	if (nodes.length === 0) {
		return null;
	}

	{
		// update pick material
		var doRecompile = false;

		if (pickMaterial.pointSizeType !== this.material.pointSizeType) {
			pickMaterial.pointSizeType = this.material.pointSizeType;
			doRecompile = true;
		}

		if (pickMaterial.pointShape !== this.material.pointShape) {
			pickMaterial.pointShape = this.material.pointShape;
			doRecompile = true;
		}

		if (pickMaterial.interpolate !== this.material.interpolate) {
			pickMaterial.interpolate = this.material.interpolate;
			doRecompile = true;
		}

		pickMaterial.size = this.material.size;
		pickMaterial.minSize = this.material.minSize;
		pickMaterial.maxSize = this.material.maxSize;
		pickMaterial.classification = this.material.classification;

		if (pickOutsideClipRegion) {
			pickMaterial.clipMode = Potree.ClipMode.DISABLED;
		} else {
			pickMaterial.clipMode = this.material.clipMode;
			if (this.material.clipMode === Potree.ClipMode.CLIP_OUTSIDE) {
				pickMaterial.setClipBoxes(this.material.clipBoxes);
			} else {
				pickMaterial.setClipBoxes([]);
			}
		}

		this.updateMaterial(pickMaterial, nodes, camera, renderer);

		if (doRecompile) {

			compileMaterial(pickMaterial);
		};
	}

	var width = Math.ceil(renderer.domElement.clientWidth);
	var height = Math.ceil(renderer.domElement.clientHeight);

	var pixelPos = new THREE.Vector3().addVectors(camera.position, ray.direction).project(camera);
	pixelPos.addScalar(1).multiplyScalar(0.5);
	pixelPos.x *= width;
	pixelPos.y *= height;

	if (!this.pickTarget) {
		this.pickTarget = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter,
			magFilter: THREE.NearestFilter,
			format: THREE.RGBAFormat });
	} else if (this.pickTarget.width != width || this.pickTarget.height != height) {
		this.pickTarget.dispose();
		this.pickTarget = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter,
			magFilter: THREE.NearestFilter,
			format: THREE.RGBAFormat });
	}
	this.pickTarget.setSize(width, height);

	gl.enable(gl.SCISSOR_TEST);
	gl.scissor(pixelPos.x - (pickWindowSize - 1) / 2, pixelPos.y - (pickWindowSize - 1) / 2, pickWindowSize, pickWindowSize);
	gl.disable(gl.SCISSOR_TEST);

	renderer.setRenderTarget(this.pickTarget);

	renderer.state.setDepthTest(pickMaterial.depthTest);
	renderer.state.setDepthWrite(pickMaterial.depthWrite);
	renderer.state.setBlending(THREE.NoBlending);

	renderer.clear(renderer.autoClearColor, renderer.autoClearDepth, renderer.autoClearStencil);

	var glstate = pickMaterial._glstate;
	var program = glstate.program;
	var uniforms = glstate.uniforms;
	gl.useProgram(program);

	gl.uniformMatrix4fv(uniforms["projectionMatrix"], false, new Float32Array(camera.projectionMatrix.elements));
	gl.uniformMatrix4fv(uniforms["viewMatrix"], false, new Float32Array(camera.matrixWorldInverse.elements));

	{
		if (glstate.textures.visibleNodes === undefined) {
			var _image = pickMaterial.visibleNodesTexture.image;
			var _texture = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, _texture);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, _image.width, _image.height, 0, gl.RGB, gl.UNSIGNED_BYTE, _image.data);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			//gl.generateMipmap(gl.TEXTURE_2D);
			gl.bindTexture(gl.TEXTURE_2D, null);
			glstate.textures.visibleNodes = {
				id: _texture
			};
		}

		var texture = glstate.textures.visibleNodes.id;
		var image = pickMaterial.visibleNodesTexture.image;

		gl.uniform1i(uniforms["visibleNodes"], 0);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, image.width, image.height, 0, gl.RGB, gl.UNSIGNED_BYTE, image.data);
	}

	gl.uniform1f(uniforms["fov"], this.material.fov);
	gl.uniform1f(uniforms["screenWidth"], this.material.screenWidth);
	gl.uniform1f(uniforms["screenHeight"], this.material.screenHeight);
	gl.uniform1f(uniforms["spacing"], this.material.spacing);
	gl.uniform1f(uniforms["near"], this.material.near);
	gl.uniform1f(uniforms["far"], this.material.far);
	gl.uniform1f(uniforms["size"], this.material.size);
	gl.uniform1f(uniforms["minSize"], this.material.minSize);
	gl.uniform1f(uniforms["maxSize"], this.material.maxSize);
	gl.uniform1f(uniforms["octreeSize"], this.pcoGeometry.boundingBox.getSize().x);

	{
		var apPosition = gl.getAttribLocation(program, "position");
		var apNormal = gl.getAttribLocation(program, "normal");
		var apClassification = gl.getAttribLocation(program, "classification");
		var apIndices = gl.getAttribLocation(program, "indices");

		gl.enableVertexAttribArray(apPosition);
		gl.enableVertexAttribArray(apNormal);
		gl.enableVertexAttribArray(apClassification);
		gl.enableVertexAttribArray(apIndices);
	}

	for (var i = 0; i < nodes.length; i++) {
		var node = nodes[i];
		var object = node.sceneNode;
		var geometry = object.geometry;

		pickMaterial.pcIndex = i + 1;

		var modelView = new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, object.matrixWorld);
		gl.uniformMatrix4fv(uniforms["modelMatrix"], false, new Float32Array(object.matrixWorld.elements));
		gl.uniformMatrix4fv(uniforms["modelViewMatrix"], false, new Float32Array(modelView.elements));

		var _apPosition = gl.getAttribLocation(program, "position");
		var _apNormal = gl.getAttribLocation(program, "normal");
		var _apClassification = gl.getAttribLocation(program, "classification");
		var _apIndices = gl.getAttribLocation(program, "indices");

		var positionBuffer = renderer.properties.get(geometry.attributes.position).__webglBuffer;

		if (positionBuffer === undefined) {
			continue;
		}

		gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
		gl.vertexAttribPointer(_apPosition, 3, gl.FLOAT, false, 0, 0);

		var normalBuffer = renderer.properties.get(geometry.attributes.normal).__webglBuffer;
		gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
		gl.vertexAttribPointer(_apNormal, 3, gl.FLOAT, true, 0, 0);

		var classificationBuffer = renderer.properties.get(geometry.attributes.classification).__webglBuffer;
		gl.bindBuffer(gl.ARRAY_BUFFER, classificationBuffer);
		gl.vertexAttribPointer(_apClassification, 1, gl.UNSIGNED_BYTE, false, 0, 0);

		var indexBuffer = renderer.properties.get(geometry.attributes.indices).__webglBuffer;
		gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
		gl.vertexAttribPointer(_apIndices, 4, gl.UNSIGNED_BYTE, true, 0, 0);

		gl.uniform1f(uniforms["pcIndex"], pickMaterial.pcIndex);

		var numPoints = node.getNumPoints();
		if (numPoints > 0) {
			gl.drawArrays(gl.POINTS, 0, node.getNumPoints());
		}
	}

	var pixelCount = pickWindowSize * pickWindowSize;
	var buffer = new ArrayBuffer(pixelCount * 4);
	var pixels = new Uint8Array(buffer);
	var ibuffer = new Uint32Array(buffer);
	renderer.context.readPixels(pixelPos.x - (pickWindowSize - 1) / 2, pixelPos.y - (pickWindowSize - 1) / 2, pickWindowSize, pickWindowSize, renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, pixels);

	//{ // open window with image
	//	var br = new ArrayBuffer(width*height*4);
	//	var bp = new Uint8Array(br);
	//	renderer.context.readPixels( 0, 0, width, height, 
	//		renderer.context.RGBA, renderer.context.UNSIGNED_BYTE, bp);
	//	
	//	var img = pixelsArrayToImage(bp, width, height);
	//	var screenshot = img.src;
	//	
	//	var w = window.open();
	//	w.document.write('<img src="'+screenshot+'"/>');
	//}

	// find closest hit inside pixelWindow boundaries
	var min = Number.MAX_VALUE;
	var hit = null;
	//console.log("finding closest hit");
	for (var u = 0; u < pickWindowSize; u++) {
		for (var v = 0; v < pickWindowSize; v++) {
			var offset = u + v * pickWindowSize;
			var distance = Math.pow(u - (pickWindowSize - 1) / 2, 2) + Math.pow(v - (pickWindowSize - 1) / 2, 2);

			var pcIndex = pixels[4 * offset + 3];
			pixels[4 * offset + 3] = 0;
			var pIndex = ibuffer[offset];

			if ((pIndex !== 0 || pcIndex !== 0) && distance < min) {

				hit = {
					pIndex: pIndex,
					pcIndex: pcIndex - 1
				};
				min = distance;
			}
		}
	}

	if (hit) {
		var point = {};

		var pc = nodes[hit.pcIndex].sceneNode;
		var attributes = pc.geometry.attributes;

		for (var property in attributes) {
			if (attributes.hasOwnProperty(property)) {
				var values = pc.geometry.attributes[property];

				if (property === "position") {
					var positionArray = values.array;
					var x = positionArray[3 * hit.pIndex + 0];
					var y = positionArray[3 * hit.pIndex + 1];
					var z = positionArray[3 * hit.pIndex + 2];
					var position = new THREE.Vector3(x, y, z);
					position.applyMatrix4(this.matrixWorld);

					point[property] = position;
				} else if (property === "indices") {} else {
					if (values.itemSize === 1) {
						point[property] = values.array[hit.pIndex];
					} else {
						var value = [];
						for (var j = 0; j < values.itemSize; j++) {
							value.push(values.array[values.itemSize * hit.pIndex + j]);
						}
						point[property] = value;
					}
				}
			}
		}

		return point;
		//return null;
	} else {
		return null;
	}
};

var demTime = 0;

Potree.PointCloudOctree.prototype.createDEM = function (node) {
	var start = new Date().getTime();

	var sceneNode = node.sceneNode;

	var world = sceneNode.matrixWorld;

	var boundingBox = sceneNode.boundingBox.clone().applyMatrix4(world);
	var bbSize = boundingBox.getSize();
	var positions = sceneNode.geometry.attributes.position.array;
	var demSize = 64;
	var demMArray = new Array(demSize * demSize);
	var dem = new Float32Array(demSize * demSize);
	var n = positions.length / 3;

	var toWorld = function toWorld(dx, dy) {
		var x = dx * bbSize.x / (demSize - 1) + boundingBox.min.x;
		var y = dem[dx + dy * demSize];
		var z = dy * bbSize.z / (demSize - 1) + boundingBox.min.z;

		return [x, y, z];
	};

	var toDem = function toDem(x, y) {
		var dx = parseInt(demSize * (x - boundingBox.min.x) / bbSize.x);
		var dy = parseInt(demSize * (z - boundingBox.min.z) / bbSize.z);
		dx = Math.min(dx, demSize - 1);
		dy = Math.min(dy, demSize - 1);

		return [dx, dy];
	};

	for (var i = 0; i < n; i++) {
		var x = positions[3 * i + 0];
		var y = positions[3 * i + 1];
		var z = positions[3 * i + 2];

		var worldPos = new THREE.Vector3(x, y, z).applyMatrix4(world);

		var dx = parseInt(demSize * (worldPos.x - boundingBox.min.x) / bbSize.x);
		var dy = parseInt(demSize * (worldPos.z - boundingBox.min.z) / bbSize.z);
		dx = Math.min(dx, demSize - 1);
		dy = Math.min(dy, demSize - 1);

		var index = dx + dy * demSize;
		if (!demMArray[index]) {
			demMArray[index] = [];
		}
		demMArray[index].push(worldPos.y);

		//if(dem[dx + dy * demSize] === 0){
		//	dem[dx + dy * demSize] = worldPos.y;
		//}else{
		//	dem[dx + dy * demSize] = Math.max(dem[dx + dy * demSize], worldPos.y);
		//}
	}

	for (var i = 0; i < demMArray.length; i++) {
		var values = demMArray[i];

		if (!values) {
			dem[i] = 0;
		} else if (values.length === 0) {
			dem[i] = 0;
		} else {
			var medianIndex = parseInt((values.length - 1) / 2);
			dem[i] = values[medianIndex];
		}
	}

	var box2 = new THREE.Box2();
	box2.expandByPoint(new THREE.Vector3(boundingBox.min.x, boundingBox.min.z));
	box2.expandByPoint(new THREE.Vector3(boundingBox.max.x, boundingBox.max.z));

	var result = {
		boundingBox: boundingBox,
		boundingBox2D: box2,
		dem: dem,
		demSize: demSize
	};

	//if(node.level === 6){
	//	var geometry = new THREE.BufferGeometry();
	//	var vertices = new Float32Array((demSize-1)*(demSize-1)*2*3*3);
	//	var offset = 0;
	//	for(var i = 0; i < demSize-1; i++){
	//		for(var j = 0; j < demSize-1; j++){
	//			//var offset = 18*i + 18*j*demSize;
	//			
	//			var dx = i;
	//			var dy = j;
	//			
	//			var v1 = toWorld(dx, dy);
	//			var v2 = toWorld(dx+1, dy);
	//			var v3 = toWorld(dx+1, dy+1);
	//			var v4 = toWorld(dx, dy+1);
	//			
	//			vertices[offset+0] = v3[0];
	//			vertices[offset+1] = v3[1];
	//			vertices[offset+2] = v3[2];
	//			
	//			vertices[offset+3] = v2[0];
	//			vertices[offset+4] = v2[1];
	//			vertices[offset+5] = v2[2];
	//			
	//			vertices[offset+6] = v1[0];
	//			vertices[offset+7] = v1[1];
	//			vertices[offset+8] = v1[2];
	//			
	//			
	//			vertices[offset+9 ] = v3[0];
	//			vertices[offset+10] = v3[1];
	//			vertices[offset+11] = v3[2];
	//			
	//			vertices[offset+12] = v1[0];
	//			vertices[offset+13] = v1[1];
	//			vertices[offset+14] = v1[2];
	//			
	//			vertices[offset+15] = v4[0];
	//			vertices[offset+16] = v4[1];
	//			vertices[offset+17] = v4[2];
	//					 
	//					
	//			
	//			//var x = (dx * bbSize.min.x) / demSize + boundingBox.min.x;
	//			//var y = (dy * bbSize.min.y) / demSize + boundingBox.min.y;
	//			//var z = dem[dx + dy * demSize];
	//			
	//			offset += 18;
	//			
	//		}
	//	}
	//	
	//	geometry.addAttribute( 'position', new THREE.BufferAttribute( vertices, 3 ) );
	//	geometry.computeFaceNormals();
	//	geometry.computeVertexNormals();
	//	
	//	var material = new THREE.MeshNormalMaterial( { color: 0xff0000, shading: THREE.SmoothShading } );
	//	var mesh = new THREE.Mesh( geometry, material );
	//	viewer.scene.add(mesh);
	//}


	//if(node.level == 0){
	//	scene.add(mesh);
	//	
	//	var demb = new Uint8Array(demSize*demSize*4);
	//	for(var i = 0; i < demSize*demSize; i++){
	//		demb[4*i + 0] = 255 * dem[i] / 300;
	//		demb[4*i + 1] = 255 * dem[i] / 300;
	//		demb[4*i + 2] = 255 * dem[i] / 300;
	//		demb[4*i + 3] = 255;
	//	}
	//
	//	var img = pixelsArrayToImage(demb, demSize, demSize);
	//	img.style.boder = "2px solid red";
	//	img.style.position = "absolute";
	//	img.style.top  = "0px";
	//	img.style.width = "400px";
	//	img.style.height = "200px";
	//	var txt = document.createElement("div");
	//	txt.innerHTML = node.name;
	//	//document.body.appendChild(txt);
	//	document.body.appendChild(img);
	//}


	var end = new Date().getTime();
	var duration = end - start;

	demTime += duration;

	return result;
};

Potree.PointCloudOctree.prototype.getDEMHeight = function (position) {
	var pos2 = new THREE.Vector2(position.x, position.z);

	var demHeight = function demHeight(dem) {
		var demSize = dem.demSize;
		var box = dem.boundingBox2D;
		var insideBox = box.containsPoint(pos2);
		if (box.containsPoint(pos2)) {
			var uv = pos2.clone().sub(box.min).divide(box.getSize());
			var xy = uv.clone().multiplyScalar(demSize);

			var demHeight = 0;

			if (xy.x > 0.5 && xy.x < demSize - 0.5 && xy.y > 0.5 && xy.y < demSize - 0.5) {
				var i = Math.floor(xy.x - 0.5);
				var j = Math.floor(xy.y - 0.5);
				i = i === demSize - 1 ? demSize - 2 : i;
				j = j === demSize - 1 ? demSize - 2 : j;

				var u = xy.x - i - 0.5;
				var v = xy.y - j - 0.5;

				var index00 = i + j * demSize;
				var index10 = i + 1 + j * demSize;
				var index01 = i + (j + 1) * demSize;
				var index11 = i + 1 + (j + 1) * demSize;

				var height00 = dem.dem[index00];
				var height10 = dem.dem[index10];
				var height01 = dem.dem[index01];
				var height11 = dem.dem[index11];

				if (height00 === 0 || height10 === 0 || height01 === 0 || height11 === 0) {
					demHeight = null;
				} else {

					var hx1 = height00 * (1 - u) + height10 * u;
					var hx2 = height01 * (1 - u) + height11 * u;

					demHeight = hx1 * (1 - v) + hx2 * v;
				}

				var bla;
			} else {
				xy.x = Math.min(parseInt(Math.min(xy.x, demSize)), demSize - 1);
				xy.y = Math.min(parseInt(Math.min(xy.y, demSize)), demSize - 1);

				var index = xy.x + xy.y * demSize;
				demHeight = dem.dem[index];
			}

			return demHeight;
		}

		return null;
	};

	var height = null;

	var stack = [];
	var chosenNode = null;
	if (this.root.dem) {
		stack.push(this.root);
	}
	while (stack.length > 0) {
		var node = stack.shift();
		var dem = node.dem;

		var demSize = dem.demSize;
		var box = dem.boundingBox2D;
		var insideBox = box.containsPoint(pos2);
		if (!insideBox) {
			continue;
		}

		var dh = demHeight(dem);
		if (!height) {
			height = dh;
		} else if (dh != null && dh > 0) {
			height = dh;
		}

		if (node.level <= 6) {
			for (var i = 0; i < 8; i++) {
				var child = node.children[i];
				if (typeof child !== "undefined" && typeof child.dem !== "undefined") {
					stack.push(child);
				}
			}
		}
	}

	return height;
};

//Potree.PointCloudOctree.prototype.generateTerain = function(){
//	var bb = this.boundingBox.clone().applyMatrix4(this.matrixWorld);
//	
//	var width = 300;
//	var height = 300;
//	var geometry = new THREE.BufferGeometry();
//	var vertices = new Float32Array(width*height*3);
//	
//	var offset = 0;
//	for(var i = 0; i < width; i++){
//		for( var j = 0; j < height; j++){
//			var u = i / width;
//			var v = j / height;
//			
//			var x = u * bb.size().x + bb.min.x;
//			var z = v * bb.size().z + bb.min.z;
//			
//			var y = this.getDEMHeight(new THREE.Vector3(x, 0, z));
//			if(!y){
//				y = 0;
//			}
//			
//			vertices[offset + 0] = x;
//			vertices[offset + 1] = y;
//			vertices[offset + 2] = z;
//			
//			//var sm = new THREE.Mesh(sg);
//			//sm.position.set(x,y,z);
//			//scene.add(sm);
//			
//			offset += 3;
//		}
//	}
//	
//	geometry.addAttribute( 'position', new THREE.BufferAttribute( vertices, 3 ) );
//	var material = new THREE.PointCloudMaterial({size: 20, color: 0x00ff00});
//	
//	var pc = new THREE.Points(geometry, material);
//	scene.add(pc);
//	
//};

Object.defineProperty(Potree.PointCloudOctree.prototype, "progress", {
	get: function get() {
		return this.visibleNodes.length / this.visibleGeometry.length;
	}
});
"use strict";

var nodesLoadTimes = {};

Potree.PointCloudOctreeGeometry = function () {
	this.url = null;
	this.octreeDir = null;
	this.spacing = 0;
	this.boundingBox = null;
	this.root = null;
	this.numNodesLoading = 0;
	this.nodes = null;
	this.pointAttributes = null;
	this.hierarchyStepSize = -1;
	this.loader = null;
};

Potree.PointCloudOctreeGeometryNode = function (name, pcoGeometry, boundingBox) {
	this.id = Potree.PointCloudOctreeGeometryNode.IDCount++;
	this.name = name;
	this.index = parseInt(name.charAt(name.length - 1));
	this.pcoGeometry = pcoGeometry;
	this.geometry = null;
	this.boundingBox = boundingBox;
	this.boundingSphere = boundingBox.getBoundingSphere();
	this.children = {};
	this.numPoints = 0;
	this.level = null;
	this.loaded = false;
	this.oneTimeDisposeHandlers = [];
};

Potree.PointCloudOctreeGeometryNode.IDCount = 0;

Potree.PointCloudOctreeGeometryNode.prototype = Object.create(Potree.PointCloudTreeNode.prototype);

Potree.PointCloudOctreeGeometryNode.prototype.isGeometryNode = function () {
	return true;
};

Potree.PointCloudOctreeGeometryNode.prototype.getLevel = function () {
	return this.level;
};

Potree.PointCloudOctreeGeometryNode.prototype.isTreeNode = function () {
	return false;
};

Potree.PointCloudOctreeGeometryNode.prototype.isLoaded = function () {
	return this.loaded;
};

Potree.PointCloudOctreeGeometryNode.prototype.getBoundingSphere = function () {
	return this.boundingSphere;
};

Potree.PointCloudOctreeGeometryNode.prototype.getBoundingBox = function () {
	return this.boundingBox;
};

Potree.PointCloudOctreeGeometryNode.prototype.getChildren = function () {
	var children = [];

	for (var i = 0; i < 8; i++) {
		if (this.children[i]) {
			children.push(this.children[i]);
		}
	}

	return children;
};

Potree.PointCloudOctreeGeometryNode.prototype.getBoundingBox = function () {
	return this.boundingBox;
};

Potree.PointCloudOctreeGeometryNode.prototype.getURL = function () {
	var url = "";

	var version = this.pcoGeometry.loader.version;

	if (version.equalOrHigher("1.5")) {
		url = this.pcoGeometry.octreeDir + "/" + this.getHierarchyPath() + "/" + this.name;
	} else if (version.equalOrHigher("1.4")) {
		url = this.pcoGeometry.octreeDir + "/" + this.name;
	} else if (version.upTo("1.3")) {
		url = this.pcoGeometry.octreeDir + "/" + this.name;
	}

	return url;
};

Potree.PointCloudOctreeGeometryNode.prototype.getHierarchyPath = function () {
	var path = "r/";

	var hierarchyStepSize = this.pcoGeometry.hierarchyStepSize;
	var indices = this.name.substr(1);

	var numParts = Math.floor(indices.length / hierarchyStepSize);
	for (var i = 0; i < numParts; i++) {
		path += indices.substr(i * hierarchyStepSize, hierarchyStepSize) + "/";
	}

	path = path.slice(0, -1);

	return path;
};

Potree.PointCloudOctreeGeometryNode.prototype.addChild = function (child) {
	this.children[child.index] = child;
	child.parent = this;
};

Potree.PointCloudOctreeGeometryNode.prototype.load = function () {
	if (this.loading === true || this.loaded === true || this.pcoGeometry.numNodesLoading > 3) {
		return;
	}

	this.loading = true;

	this.pcoGeometry.numNodesLoading++;

	if (this.pcoGeometry.loader.version.equalOrHigher("1.5")) {
		if (this.level % this.pcoGeometry.hierarchyStepSize === 0 && this.hasChildren) {
			this.loadHierachyThenPoints();
		} else {
			this.loadPoints();
		}
	} else {
		this.loadPoints();
	}
};

Potree.PointCloudOctreeGeometryNode.prototype.loadPoints = function () {
	this.pcoGeometry.loader.load(this);
};

Potree.PointCloudOctreeGeometryNode.prototype.loadHierachyThenPoints = function () {

	var node = this;

	// load hierarchy
	var callback = function callback(node, hbuffer) {
		var count = hbuffer.byteLength / 5;
		var view = new DataView(hbuffer);

		var stack = [];
		var children = view.getUint8(0);
		var numPoints = view.getUint32(1, true);
		node.numPoints = numPoints;
		stack.push({ children: children, numPoints: numPoints, name: node.name });

		var decoded = [];

		var offset = 5;
		while (stack.length > 0) {

			var snode = stack.shift();
			var mask = 1;
			for (var i = 0; i < 8; i++) {
				if ((snode.children & mask) !== 0) {
					var childIndex = i;
					var childName = snode.name + i;

					var childChildren = view.getUint8(offset);
					var childNumPoints = view.getUint32(offset + 1, true);

					stack.push({ children: childChildren, numPoints: childNumPoints, name: childName });

					decoded.push({ children: childChildren, numPoints: childNumPoints, name: childName });

					offset += 5;
				}

				mask = mask * 2;
			}

			if (offset === hbuffer.byteLength) {
				break;
			}
		}

		//console.log(decoded);

		var nodes = {};
		nodes[node.name] = node;
		var pco = node.pcoGeometry;

		for (var i = 0; i < decoded.length; i++) {
			var name = decoded[i].name;
			var numPoints = decoded[i].numPoints;
			var index = parseInt(name.charAt(name.length - 1));
			var parentName = name.substring(0, name.length - 1);
			var parentNode = nodes[parentName];
			var level = name.length - 1;
			var boundingBox = Potree.POCLoader.createChildAABB(parentNode.boundingBox, index);

			var currentNode = new Potree.PointCloudOctreeGeometryNode(name, pco, boundingBox);
			currentNode.level = level;
			currentNode.numPoints = numPoints;
			currentNode.hasChildren = decoded[i].children > 0;
			parentNode.addChild(currentNode);
			nodes[name] = currentNode;
		}

		node.loadPoints();
	};
	if (node.level % node.pcoGeometry.hierarchyStepSize === 0) {
		//var hurl = node.pcoGeometry.octreeDir + "/../hierarchy/" + node.name + ".hrc";
		var hurl = node.pcoGeometry.octreeDir + "/" + node.getHierarchyPath() + "/" + node.name + ".hrc";

		var xhr = new XMLHttpRequest();
		xhr.open('GET', hurl, true);
		xhr.responseType = 'arraybuffer';
		xhr.overrideMimeType('text/plain; charset=x-user-defined');
		xhr.onreadystatechange = function () {
			if (xhr.readyState === 4) {
				if (xhr.status === 200 || xhr.status === 0) {
					var hbuffer = xhr.response;
					callback(node, hbuffer);
				} else {
					console.log('Failed to load file! HTTP status: ' + xhr.status + ", file: " + url);
				}
			}
		};
		try {
			xhr.send(null);
		} catch (e) {
			console.log("fehler beim laden der punktwolke: " + e);
		}
	}
};

Potree.PointCloudOctreeGeometryNode.prototype.getNumPoints = function () {
	return this.numPoints;
};

Potree.PointCloudOctreeGeometryNode.prototype.dispose = function () {
	if (this.geometry && this.parent != null) {
		this.geometry.dispose();
		this.geometry = null;
		this.loaded = false;

		//this.dispatchEvent( { type: 'dispose' } );
		for (var i = 0; i < this.oneTimeDisposeHandlers.length; i++) {
			var handler = this.oneTimeDisposeHandlers[i];
			handler();
		}
		this.oneTimeDisposeHandlers = [];
	}
};

//THREE.EventDispatcher.prototype.apply( Potree.PointCloudOctreeGeometryNode.prototype );
Object.assign(Potree.PointCloudOctreeGeometryNode.prototype, THREE.EventDispatcher.prototype);
"use strict";

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

Potree.utils = function () {
	function _class() {
		_classCallCheck(this, _class);
	}

	_createClass(_class, null, [{
		key: "toString",
		value: function toString(value) {
			if (value instanceof THREE.Vector3) {
				return value.x.toFixed(2) + ", " + value.y.toFixed(2) + ", " + value.z.toFixed(2);
			} else {
				return "" + value + "";
			}
		}
	}, {
		key: "normalizeURL",
		value: function normalizeURL(url) {
			var u = new URL(url);

			return u.protocol + "//" + u.hostname + u.pathname.replace(/\/+/g, "/");
		}
	}, {
		key: "pathExists",
		value: function pathExists(url) {
			var req = new XMLHttpRequest();
			req.open('GET', url, false);
			req.send(null);
			if (req.status !== 200) {
				return false;
			}
			return true;
		}
	}, {
		key: "computeTransformedBoundingBox",


		/**
   * adapted from mhluska at https://github.com/mrdoob/three.js/issues/1561
   */
		value: function computeTransformedBoundingBox(box, transform) {

			var vertices = [new THREE.Vector3(box.min.x, box.min.y, box.min.z).applyMatrix4(transform), new THREE.Vector3(box.min.x, box.min.y, box.min.z).applyMatrix4(transform), new THREE.Vector3(box.max.x, box.min.y, box.min.z).applyMatrix4(transform), new THREE.Vector3(box.min.x, box.max.y, box.min.z).applyMatrix4(transform), new THREE.Vector3(box.min.x, box.min.y, box.max.z).applyMatrix4(transform), new THREE.Vector3(box.min.x, box.max.y, box.max.z).applyMatrix4(transform), new THREE.Vector3(box.max.x, box.max.y, box.min.z).applyMatrix4(transform), new THREE.Vector3(box.max.x, box.min.y, box.max.z).applyMatrix4(transform), new THREE.Vector3(box.max.x, box.max.y, box.max.z).applyMatrix4(transform)];

			var boundingBox = new THREE.Box3();
			boundingBox.setFromPoints(vertices);

			return boundingBox;
		}
	}, {
		key: "addCommas",


		/**
   * add separators to large numbers
   * 
   * @param nStr
   * @returns
   */
		value: function addCommas(nStr) {
			nStr += '';
			var x = nStr.split('.');
			var x1 = x[0];
			var x2 = x.length > 1 ? '.' + x[1] : '';
			var rgx = /(\d+)(\d{3})/;
			while (rgx.test(x1)) {
				x1 = x1.replace(rgx, '$1' + ',' + '$2');
			}
			return x1 + x2;
		}
	}, {
		key: "createWorker",


		/**
   * create worker from a string
   *
   * code from http://stackoverflow.com/questions/10343913/how-to-create-a-web-worker-from-a-string
   */
		value: function createWorker(code) {
			var blob = new Blob([code], { type: 'application/javascript' });
			var worker = new Worker(URL.createObjectURL(blob));

			return worker;
		}
	}, {
		key: "loadSkybox",
		value: function loadSkybox(path) {
			var camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 100000);
			var scene = new THREE.Scene();

			var format = ".jpg";
			var urls = [path + 'px' + format, path + 'nx' + format, path + 'py' + format, path + 'ny' + format, path + 'pz' + format, path + 'nz' + format];

			var textureCube = THREE.ImageUtils.loadTextureCube(urls, THREE.CubeRefractionMapping);

			var shader = {
				uniforms: {
					"tCube": { type: "t", value: textureCube },
					"tFlip": { type: "f", value: -1 }
				},
				vertexShader: THREE.ShaderLib["cube"].vertexShader,
				fragmentShader: THREE.ShaderLib["cube"].fragmentShader
			};

			var material = new THREE.ShaderMaterial({
				fragmentShader: shader.fragmentShader,
				vertexShader: shader.vertexShader,
				uniforms: shader.uniforms,
				depthWrite: false,
				side: THREE.BackSide
			});
			var mesh = new THREE.Mesh(new THREE.BoxGeometry(100, 100, 100), material);
			scene.add(mesh);

			return { "camera": camera, "scene": scene };
		}
	}, {
		key: "createGrid",
		value: function createGrid(width, length, spacing, color) {
			var material = new THREE.LineBasicMaterial({
				color: color || 0x888888
			});

			var geometry = new THREE.Geometry();
			for (var i = 0; i <= length; i++) {
				geometry.vertices.push(new THREE.Vector3(-(spacing * width) / 2, i * spacing - spacing * length / 2, 0));
				geometry.vertices.push(new THREE.Vector3(+(spacing * width) / 2, i * spacing - spacing * length / 2, 0));
			}

			for (var _i = 0; _i <= width; _i++) {
				geometry.vertices.push(new THREE.Vector3(_i * spacing - spacing * width / 2, -(spacing * length) / 2, 0));
				geometry.vertices.push(new THREE.Vector3(_i * spacing - spacing * width / 2, +(spacing * length) / 2, 0));
			}

			var line = new THREE.Line(geometry, material, THREE.LinePieces);
			line.receiveShadow = true;
			return line;
		}
	}, {
		key: "createBackgroundTexture",
		value: function createBackgroundTexture(width, height) {

			function gauss(x, y) {
				return 1 / (2 * Math.PI) * Math.exp(-(x * x + y * y) / 2);
			};

			//map.magFilter = THREE.NearestFilter;
			var size = width * height;
			var data = new Uint8Array(3 * size);

			var chroma = [1, 1.5, 1.7];
			var max = gauss(0, 0);

			for (var x = 0; x < width; x++) {
				for (var y = 0; y < height; y++) {
					var u = 2 * (x / width) - 1;
					var v = 2 * (y / height) - 1;

					var i = x + width * y;
					var d = gauss(2 * u, 2 * v) / max;
					var r = (Math.random() + Math.random() + Math.random()) / 3;
					r = (d * 0.5 + 0.5) * r * 0.03;
					r = r * 0.4;

					//d = Math.pow(d, 0.6);

					data[3 * i + 0] = 255 * (d / 15 + 0.05 + r) * chroma[0];
					data[3 * i + 1] = 255 * (d / 15 + 0.05 + r) * chroma[1];
					data[3 * i + 2] = 255 * (d / 15 + 0.05 + r) * chroma[2];
				}
			}

			var texture = new THREE.DataTexture(data, width, height, THREE.RGBFormat);
			texture.needsUpdate = true;

			return texture;
		}
	}, {
		key: "getMousePointCloudIntersection",
		value: function getMousePointCloudIntersection(mouse, camera, renderer, pointclouds) {
			var vector = new THREE.Vector3(mouse.x, mouse.y, 0.5);
			vector.unproject(camera);

			var direction = vector.sub(camera.position).normalize();
			var ray = new THREE.Ray(camera.position, direction);

			var closestPoint = null;
			var closestPointDistance = null;

			for (var i = 0; i < pointclouds.length; i++) {
				var pointcloud = pointclouds[i];
				var point = pointcloud.pick(renderer, camera, ray);

				if (!point) {
					continue;
				}

				var distance = camera.position.distanceTo(point.position);

				if (!closestPoint || distance < closestPointDistance) {
					closestPoint = point;
					closestPointDistance = distance;
				}
			}

			return closestPoint ? closestPoint.position : null;
		}
	}, {
		key: "pixelsArrayToImage",
		value: function pixelsArrayToImage(pixels, width, height) {
			var canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;

			var context = canvas.getContext('2d');

			pixels = new pixels.constructor(pixels);

			for (var i = 0; i < pixels.length; i++) {
				pixels[i * 4 + 3] = 255;
			}

			var imageData = context.createImageData(width, height);
			imageData.data.set(pixels);
			context.putImageData(imageData, 0, 0);

			var img = new Image();
			img.src = canvas.toDataURL();
			//img.style.transform = "scaleY(-1)";

			return img;
		}
	}, {
		key: "projectedRadius",
		value: function projectedRadius(radius, fov, distance, screenHeight) {
			var projFactor = 1 / Math.tan(fov / 2) / distance;
			projFactor = projFactor * screenHeight / 2;

			return radius * projFactor;
		}
	}, {
		key: "topView",
		value: function topView(camera, node) {
			camera.position.set(0, 1, 0);
			camera.rotation.set(-Math.PI / 2, 0, 0);
			camera.zoomTo(node, 1);
		}
	}, {
		key: "frontView",
		value: function frontView(camera, node) {
			camera.position.set(0, 0, 1);
			camera.rotation.set(0, 0, 0);
			camera.zoomTo(node, 1);
		}
	}, {
		key: "leftView",
		value: function leftView(camera, node) {
			camera.position.set(-1, 0, 0);
			camera.rotation.set(0, -Math.PI / 2, 0);
			camera.zoomTo(node, 1);
		}
	}, {
		key: "rightView",
		value: function rightView(camera, node) {
			camera.position.set(1, 0, 0);
			camera.rotation.set(0, Math.PI / 2, 0);
			camera.zoomTo(node, 1);
		}
	}, {
		key: "frustumSphereIntersection",


		/**
   *  
   * 0: no intersection
   * 1: intersection
   * 2: fully inside
   */
		value: function frustumSphereIntersection(frustum, sphere) {
			var planes = frustum.planes;
			var center = sphere.center;
			var negRadius = -sphere.radius;

			var minDistance = Number.MAX_VALUE;

			for (var i = 0; i < 6; i++) {

				var distance = planes[i].distanceToPoint(center);

				if (distance < negRadius) {

					return 0;
				}

				minDistance = Math.min(minDistance, distance);
			}

			return minDistance >= sphere.radius ? 2 : 1;
		}
	}, {
		key: "generateDataTexture",


		// code taken from three.js
		// ImageUtils - generateDataTexture()
		value: function generateDataTexture(width, height, color) {
			var size = width * height;
			var data = new Uint8Array(3 * width * height);

			var r = Math.floor(color.r * 255);
			var g = Math.floor(color.g * 255);
			var b = Math.floor(color.b * 255);

			for (var i = 0; i < size; i++) {
				data[i * 3] = r;
				data[i * 3 + 1] = g;
				data[i * 3 + 2] = b;
			}

			var texture = new THREE.DataTexture(data, width, height, THREE.RGBFormat);
			texture.needsUpdate = true;
			texture.magFilter = THREE.NearestFilter;

			return texture;
		}
	}, {
		key: "getParameterByName",


		// from http://stackoverflow.com/questions/901115/how-can-i-get-query-string-values-in-javascript
		value: function getParameterByName(name) {
			name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
			var regex = new RegExp("[\\?&]" + name + "=([^&#]*)"),
			    results = regex.exec(location.search);
			return results === null ? null : decodeURIComponent(results[1].replace(/\+/g, " "));
		}
	}]);

	return _class;
}();

Potree.utils.screenPass = new function () {

	this.screenScene = new THREE.Scene();
	this.screenQuad = new THREE.Mesh(new THREE.PlaneBufferGeometry(2, 2, 0));
	this.screenQuad.material.depthTest = true;
	this.screenQuad.material.depthWrite = true;
	this.screenQuad.material.transparent = true;
	this.screenScene.add(this.screenQuad);
	this.camera = new THREE.Camera();

	this.render = function (renderer, material, target) {
		this.screenQuad.material = material;

		if (typeof target === "undefined") {
			renderer.render(this.screenScene, this.camera);
		} else {
			renderer.render(this.screenScene, this.camera, target);
		}
	};
}();
"use strict";

Potree.Features = function () {

	var ftCanvas = document.createElement("canvas");
	var gl = ftCanvas.getContext("webgl") || ftCanvas.getContext("experimental-webgl");
	if (gl === null) return null;

	// -- code taken from THREE.WebGLRenderer --
	var _vertexShaderPrecisionHighpFloat = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.HIGH_FLOAT);
	var _vertexShaderPrecisionMediumpFloat = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.MEDIUM_FLOAT);
	var _vertexShaderPrecisionLowpFloat = gl.getShaderPrecisionFormat(gl.VERTEX_SHADER, gl.LOW_FLOAT);

	var _fragmentShaderPrecisionHighpFloat = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
	var _fragmentShaderPrecisionMediumpFloat = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT);
	var _fragmentShaderPrecisionLowpFloat = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.LOW_FLOAT);

	var highpAvailable = _vertexShaderPrecisionHighpFloat.precision > 0 && _fragmentShaderPrecisionHighpFloat.precision > 0;
	var mediumpAvailable = _vertexShaderPrecisionMediumpFloat.precision > 0 && _fragmentShaderPrecisionMediumpFloat.precision > 0;
	// -----------------------------------------

	var precision;
	if (highpAvailable) {
		precision = "highp";
	} else if (mediumpAvailable) {
		precision = "mediump";
	} else {
		precision = "lowp";
	}

	return {
		SHADER_INTERPOLATION: {
			isSupported: function isSupported() {

				var supported = true;

				supported = supported && gl.getExtension("EXT_frag_depth");
				supported = supported && gl.getParameter(gl.MAX_VARYING_VECTORS) >= 8;

				return supported;
			}
		},
		SHADER_SPLATS: {
			isSupported: function isSupported() {

				var supported = true;

				supported = supported && gl.getExtension("EXT_frag_depth");
				supported = supported && gl.getExtension("OES_texture_float");
				supported = supported && gl.getParameter(gl.MAX_VARYING_VECTORS) >= 8;

				return supported;
			}

		},
		SHADER_EDL: {
			isSupported: function isSupported() {

				var supported = true;

				supported = supported && gl.getExtension("EXT_frag_depth");
				supported = supported && gl.getExtension("OES_texture_float");
				supported = supported && gl.getParameter(gl.MAX_VARYING_VECTORS) >= 8;

				return supported;
			}

		},
		precision: precision
	};
}();
"use strict";

/**
 * adapted from http://stemkoski.github.io/Three.js/Sprite-Text-Labels.html
 */

Potree.TextSprite = function (text) {

	THREE.Object3D.call(this);

	var scope = this;

	var texture = new THREE.Texture();
	texture.minFilter = THREE.LinearFilter;
	texture.magFilter = THREE.LinearFilter;
	var spriteMaterial = new THREE.SpriteMaterial({
		map: texture,
		//useScreenCoordinates: false,
		depthTest: false,
		depthWrite: false });

	this.material = spriteMaterial;
	this.sprite = new THREE.Sprite(spriteMaterial);
	this.add(this.sprite);

	//THREE.Sprite.call(this, spriteMaterial);

	this.borderThickness = 4;
	this.fontface = "Arial";
	this.fontsize = 28;
	this.borderColor = { r: 0, g: 0, b: 0, a: 1.0 };
	this.backgroundColor = { r: 255, g: 255, b: 255, a: 1.0 };
	this.textColor = { r: 255, g: 255, b: 255, a: 1.0 };
	this.text = "";

	this.setText(text);
};

Potree.TextSprite.prototype = new THREE.Object3D();

Potree.TextSprite.prototype.setText = function (text) {
	if (this.text !== text) {
		this.text = text;

		this.update();
	}
};

Potree.TextSprite.prototype.setTextColor = function (color) {
	this.textColor = color;

	this.update();
};

Potree.TextSprite.prototype.setBorderColor = function (color) {
	this.borderColor = color;

	this.update();
};

Potree.TextSprite.prototype.setBackgroundColor = function (color) {
	this.backgroundColor = color;

	this.update();
};

Potree.TextSprite.prototype.update = function () {

	var canvas = document.createElement('canvas');
	var context = canvas.getContext('2d');
	context.font = "Bold " + this.fontsize + "px " + this.fontface;

	// get size data (height depends only on font size)
	var metrics = context.measureText(this.text);
	var textWidth = metrics.width;
	var margin = 5;
	var spriteWidth = 2 * margin + textWidth + 2 * this.borderThickness;
	var spriteHeight = this.fontsize * 1.4 + 2 * this.borderThickness;

	var canvas = document.createElement('canvas');
	var context = canvas.getContext('2d');
	context.canvas.width = spriteWidth;
	context.canvas.height = spriteHeight;
	context.font = "Bold " + this.fontsize + "px " + this.fontface;

	// background color
	context.fillStyle = "rgba(" + this.backgroundColor.r + "," + this.backgroundColor.g + "," + this.backgroundColor.b + "," + this.backgroundColor.a + ")";
	// border color
	context.strokeStyle = "rgba(" + this.borderColor.r + "," + this.borderColor.g + "," + this.borderColor.b + "," + this.borderColor.a + ")";

	context.lineWidth = this.borderThickness;
	this.roundRect(context, this.borderThickness / 2, this.borderThickness / 2, textWidth + this.borderThickness + 2 * margin, this.fontsize * 1.4 + this.borderThickness, 6);

	// text color
	context.strokeStyle = "rgba(0, 0, 0, 1.0)";
	context.strokeText(this.text, this.borderThickness + margin, this.fontsize + this.borderThickness);

	context.fillStyle = "rgba(" + this.textColor.r + "," + this.textColor.g + "," + this.textColor.b + "," + this.textColor.a + ")";
	context.fillText(this.text, this.borderThickness + margin, this.fontsize + this.borderThickness);

	var texture = new THREE.Texture(canvas);
	texture.minFilter = THREE.LinearFilter;
	texture.magFilter = THREE.LinearFilter;
	texture.needsUpdate = true;

	//var spriteMaterial = new THREE.SpriteMaterial( 
	//	{ map: texture, useScreenCoordinates: false } );
	this.sprite.material.map = texture;

	this.sprite.scale.set(spriteWidth * 0.01, spriteHeight * 0.01, 1.0);

	//this.material = spriteMaterial;						  
};

Potree.TextSprite.prototype.roundRect = function (ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
	ctx.closePath();
	ctx.fill();
	ctx.stroke();
};
"use strict";

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

// 
// TODO 
// 
// - option to look along path during animation
// - 
// 


Potree.AnimationPath = function () {
	function _class() {
		var points = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : [];

		_classCallCheck(this, _class);

		this.points = points;
		this.spline = new THREE.Spline(points);
		this.spline.reparametrizeByArcLength(1 / this.spline.getLength().total);
		this.tween = null;
	}

	_createClass(_class, [{
		key: "get",
		value: function get(t) {
			return this.spline.getPoint(t);
		}
	}, {
		key: "animate",
		value: function animate() {
			var _this = this;

			var metersPerSecond = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 1;


			stop();

			var length = this.spline.getLength().total;
			var animationDuration = 1000 * length / metersPerSecond;

			var progress = { t: 0 };
			this.tween = new TWEEN.Tween(progress).to({ t: 1 }, animationDuration);
			this.tween.easing(TWEEN.Easing.Linear.None);
			this.tween.onUpdate(function (e) {
				viewer.scene.view.position.copy(_this.spline.getPoint(progress.t));
			});

			this.tween.start();
		}
	}, {
		key: "stop",
		value: function stop() {
			if (this.tween) {
				this.tween.stop();
			}
		}
	}, {
		key: "resume",
		value: function resume() {
			if (this.tween) {
				this.tween.start();
			}
		}
	}, {
		key: "getGeometry",
		value: function getGeometry() {
			var geometry = new THREE.Geometry();

			var samples = 100;
			var i = 0;
			for (var u = 0; u <= 1; u += 1 / samples) {
				var position = this.spline.getPoint(u);
				geometry.vertices[i] = new THREE.Vector3(position.x, position.y, position.z);

				i++;
			}

			return geometry;

			//let material = new THREE.LineBasicMaterial( { color: 0xffffff, opacity: 1, linewidth: 2 } );
			//let line = new THREE.Line(geometry, material);
			//viewer.scene.scene.add(line);
		}
	}]);

	return _class;
}();

//let target = new THREE.Vector3(589854.34, 231411.19, 692.77)
//let points = [
//	new THREE.Vector3(589815.52, 231738.31, 959.48 ),
//	new THREE.Vector3(589604.73, 231615.00, 968.10 ),
//	new THREE.Vector3(589579.11, 231354.41, 1010.06),
//	new THREE.Vector3(589723.00, 231169.95, 1015.57),
//	new THREE.Vector3(589960.76, 231116.87, 978.60 ),
//	new THREE.Vector3(590139.29, 231268.71, 972.33 )
//]
//
//let path = new Potree.AnimationPath(points);
"use strict";

Potree.Version = function (version) {
	this.version = version;
	var vmLength = version.indexOf(".") === -1 ? version.length : version.indexOf(".");
	this.versionMajor = parseInt(version.substr(0, vmLength));
	this.versionMinor = parseInt(version.substr(vmLength + 1));
	if (this.versionMinor.length === 0) {
		this.versionMinor = 0;
	}
};

Potree.Version.prototype.newerThan = function (version) {
	var v = new Potree.Version(version);

	if (this.versionMajor > v.versionMajor) {
		return true;
	} else if (this.versionMajor === v.versionMajor && this.versionMinor > v.versionMinor) {
		return true;
	} else {
		return false;
	}
};

Potree.Version.prototype.equalOrHigher = function (version) {
	var v = new Potree.Version(version);

	if (this.versionMajor > v.versionMajor) {
		return true;
	} else if (this.versionMajor === v.versionMajor && this.versionMinor >= v.versionMinor) {
		return true;
	} else {
		return false;
	}
};

Potree.Version.prototype.upTo = function (version) {
	return !this.newerThan(version);
};
"use strict";

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

Potree.Measure = function () {
	function _class() {
		_classCallCheck(this, _class);

		this.sceneNode = new THREE.Object3D();
		this.dispatcher = new THREE.EventDispatcher();

		this.points = [];
		this._showDistances = true;
		this._showCoordinates = false;
		this._showArea = false;
		this._closed = true;
		this._showAngles = false;
		this.maxMarkers = Number.MAX_SAFE_INTEGER;

		this.spheres = [];
		this.edges = [];
		this.sphereLabels = [];
		this.edgeLabels = [];
		this.angleLabels = [];
		this.coordinateLabels = [];

		this.areaLabel = new Potree.TextSprite("");
		this.areaLabel.setBorderColor({ r: 0, g: 0, b: 0, a: 0.8 });
		this.areaLabel.setBackgroundColor({ r: 0, g: 0, b: 0, a: 0.3 });
		this.areaLabel.setTextColor({ r: 180, g: 220, b: 180, a: 1.0 });
		this.areaLabel.material.depthTest = false;
		this.areaLabel.material.opacity = 1;
		this.areaLabel.visible = false;;
		this.sceneNode.add(this.areaLabel);

		this.sphereGeometry = new THREE.SphereGeometry(0.4, 10, 10);
		this.color = new THREE.Color(0xff0000);
	}

	_createClass(_class, [{
		key: "createSphereMaterial",
		value: function createSphereMaterial() {
			var sphereMaterial = new THREE.MeshLambertMaterial({
				shading: THREE.SmoothShading,
				color: this.color,
				depthTest: false,
				depthWrite: false });

			return sphereMaterial;
		}
	}, {
		key: "addMarker",
		value: function addMarker(point) {
			var _this = this;

			if (point instanceof THREE.Vector3) {
				point = { position: point };
			}
			this.points.push(point);

			// sphere
			var sphere = new THREE.Mesh(this.sphereGeometry, this.createSphereMaterial());

			{
				var moveEvent = function moveEvent(event) {
					event.target.material.emissive.setHex(0x888888);
				};

				var leaveEvent = function leaveEvent(event) {
					event.target.material.emissive.setHex(0x000000);
				};

				var dragEvent = function dragEvent(event) {
					var tool = event.tool;
					var dragstart = tool.dragstart;
					var mouse = tool.mouse;

					var point = tool.getMousePointCloudIntersection.bind(tool)();

					if (point) {
						var index = _this.spheres.indexOf(tool.dragstart.object);
						_this.setMarker(index, point);
					}

					event.event.stopImmediatePropagation();
				};

				var dropEvent = function dropEvent(event) {};

				sphere.addEventListener("move", moveEvent);
				sphere.addEventListener("leave", leaveEvent);
				sphere.addEventListener("drag", dragEvent);
				sphere.addEventListener("drop", dropEvent);
			}

			this.sceneNode.add(sphere);
			this.spheres.push(sphere);

			{
				// edges
				var lineGeometry = new THREE.Geometry();
				lineGeometry.vertices.push(new THREE.Vector3(), new THREE.Vector3());
				lineGeometry.colors.push(this.color, this.color, this.color);
				var lineMaterial = new THREE.LineBasicMaterial({
					linewidth: 1
				});
				lineMaterial.depthTest = false;
				var edge = new THREE.Line(lineGeometry, lineMaterial);
				edge.visible = true;

				this.sceneNode.add(edge);
				this.edges.push(edge);
			}

			{
				// edge labels
				var edgeLabel = new Potree.TextSprite();
				edgeLabel.setBorderColor({ r: 0, g: 0, b: 0, a: 0.8 });
				edgeLabel.setBackgroundColor({ r: 0, g: 0, b: 0, a: 0.3 });
				edgeLabel.material.depthTest = false;
				edgeLabel.visible = false;
				this.edgeLabels.push(edgeLabel);
				this.sceneNode.add(edgeLabel);
			}

			{
				// angle labels
				var angleLabel = new Potree.TextSprite();
				angleLabel.setBorderColor({ r: 0, g: 0, b: 0, a: 0.8 });
				angleLabel.setBackgroundColor({ r: 0, g: 0, b: 0, a: 0.3 });
				angleLabel.material.depthTest = false;
				angleLabel.material.opacity = 1;
				angleLabel.visible = false;
				this.angleLabels.push(angleLabel);
				this.sceneNode.add(angleLabel);
			}

			{
				// coordinate labels
				var coordinateLabel = new Potree.TextSprite();
				coordinateLabel.setBorderColor({ r: 0, g: 0, b: 0, a: 0.8 });
				coordinateLabel.setBackgroundColor({ r: 0, g: 0, b: 0, a: 0.3 });
				coordinateLabel.material.depthTest = false;
				coordinateLabel.material.opacity = 1;
				coordinateLabel.visible = false;
				this.coordinateLabels.push(coordinateLabel);
				this.sceneNode.add(coordinateLabel);
			}

			var event = {
				type: "marker_added",
				measurement: this
			};
			this.dispatcher.dispatchEvent(event);

			this.setMarker(this.points.length - 1, point);
		}
	}, {
		key: "removeMarker",
		value: function removeMarker(index) {
			this.points.splice(index, 1);

			this.sceneNode.remove(this.spheres[index]);

			var edgeIndex = index === 0 ? 0 : index - 1;
			this.sceneNode.remove(this.edges[edgeIndex]);
			this.edges.splice(edgeIndex, 1);

			this.sceneNode.remove(this.edgeLabels[edgeIndex]);
			this.edgeLabels.splice(edgeIndex, 1);
			this.coordinateLabels.splice(index, 1);

			this.spheres.splice(index, 1);

			this.update();

			this.dispatcher.dispatchEvent({ type: "marker_removed", measurement: this });
		}
	}, {
		key: "setMarker",
		value: function setMarker(index, point) {
			this.points[index] = point;

			var event = {
				type: 'marker_moved',
				measure: this,
				index: index,
				position: point.position.clone()
			};
			this.dispatcher.dispatchEvent(event);

			this.update();
		}
	}, {
		key: "setPosition",
		value: function setPosition(index, position) {
			var point = this.points[index];
			point.position.copy(position);

			var event = {
				type: 'marker_moved',
				measure: this,
				index: index,
				position: position.clone()
			};
			this.dispatcher.dispatchEvent(event);

			this.update();
		}
	}, {
		key: "getArea",
		value: function getArea() {
			var area = 0;
			var j = this.points.length - 1;

			for (var i = 0; i < this.points.length; i++) {
				var p1 = this.points[i].position;
				var p2 = this.points[j].position;
				area += (p2.x + p1.x) * (p1.z - p2.z);
				j = i;
			}

			return Math.abs(area / 2);
		}
	}, {
		key: "getAngleBetweenLines",
		value: function getAngleBetweenLines(cornerPoint, point1, point2) {
			var v1 = new THREE.Vector3().subVectors(point1.position, cornerPoint.position);
			var v2 = new THREE.Vector3().subVectors(point2.position, cornerPoint.position);
			return v1.angleTo(v2);
		}
	}, {
		key: "getAngle",
		value: function getAngle(index) {

			if (this.points.length < 3 || index >= this.points.length) {
				return 0;
			}

			var previous = index === 0 ? this.points[this.points.length - 1] : this.points[index - 1];
			var point = this.points[index];
			var next = this.points[(index + 1) % this.points.length];

			return this.getAngleBetweenLines(point, previous, next);
		}
	}, {
		key: "update",
		value: function update() {

			if (this.points.length === 0) {
				return;
			} else if (this.points.length === 1) {
				var point = this.points[0];
				var position = point.position;
				this.spheres[0].position.copy(position);

				{
					// coordinate labels
					var coordinateLabel = this.coordinateLabels[0];

					var labelPos = position.clone().add(new THREE.Vector3(0, 1, 0));
					coordinateLabel.position.copy(labelPos);

					var _msg = Potree.utils.addCommas(position.x.toFixed(2)) + " / " + Potree.utils.addCommas(position.y.toFixed(2)) + " / " + Potree.utils.addCommas(position.z.toFixed(2));
					coordinateLabel.setText(_msg);

					//coordinateLabel.visible = this.showCoordinates && (index < lastIndex || this.closed);
				}

				return;
			}

			var lastIndex = this.points.length - 1;

			var centroid = new THREE.Vector3();
			for (var i = 0; i <= lastIndex; i++) {
				var _point = this.points[i];
				centroid.add(_point.position);
			}
			centroid.divideScalar(this.points.length);

			for (var _i = 0; _i <= lastIndex; _i++) {
				var index = _i;
				var nextIndex = _i + 1 > lastIndex ? 0 : _i + 1;
				var previousIndex = _i === 0 ? lastIndex : _i - 1;

				var _point2 = this.points[index];
				var nextPoint = this.points[nextIndex];
				var previousPoint = this.points[previousIndex];

				var sphere = this.spheres[index];

				// spheres
				sphere.position.copy(_point2.position);
				sphere.material.color = this.color;

				{
					// edges
					var edge = this.edges[index];

					edge.material.color = this.color;

					edge.geometry.vertices[0].copy(_point2.position);
					edge.geometry.vertices[1].copy(nextPoint.position);

					edge.geometry.verticesNeedUpdate = true;
					edge.geometry.computeBoundingSphere();
					edge.visible = index < lastIndex || this.closed;
				}

				{
					// edge labels
					var edgeLabel = this.edgeLabels[_i];

					var center = new THREE.Vector3().add(_point2.position);
					center.add(nextPoint.position);
					center = center.multiplyScalar(0.5);
					var distance = _point2.position.distanceTo(nextPoint.position);

					edgeLabel.position.copy(center);
					edgeLabel.setText(Potree.utils.addCommas(distance.toFixed(2)));
					edgeLabel.visible = this.showDistances && (index < lastIndex || this.closed) && this.points.length >= 2 && distance > 0;
				}

				{
					// angle labels
					var angleLabel = this.angleLabels[_i];
					var angle = this.getAngleBetweenLines(_point2, previousPoint, nextPoint);

					var dir = nextPoint.position.clone().sub(previousPoint.position);
					dir.multiplyScalar(0.5);
					dir = previousPoint.position.clone().add(dir).sub(_point2.position).normalize();

					var dist = Math.min(_point2.position.distanceTo(previousPoint.position), _point2.position.distanceTo(nextPoint.position));
					dist = dist / 9;

					var _labelPos = _point2.position.clone().add(dir.multiplyScalar(dist));
					angleLabel.position.copy(_labelPos);

					var _msg2 = Potree.utils.addCommas((angle * (180.0 / Math.PI)).toFixed(1)) + "\xB0";
					angleLabel.setText(_msg2);

					angleLabel.visible = this.showAngles && (index < lastIndex || this.closed) && this.points.length >= 3 && angle > 0;
				}

				{
					// coordinate labels
					var _coordinateLabel = this.coordinateLabels[0];

					var _labelPos2 = _point2.position.clone().add(new THREE.Vector3(0, 1, 0));
					_coordinateLabel.position.copy(_labelPos2);

					var _msg3 = Potree.utils.addCommas(_point2.position.x.toFixed(2)) + " / " + Potree.utils.addCommas(_point2.position.y.toFixed(2)) + " / " + Potree.utils.addCommas(_point2.position.z.toFixed(2));
					_coordinateLabel.setText(_msg3);

					_coordinateLabel.visible = this.showCoordinates && (index < lastIndex || this.closed);
				}
			}

			// update area label
			this.areaLabel.position.copy(centroid);
			this.areaLabel.visible = this.showArea && this.points.length >= 3;
			var msg = Potree.utils.addCommas(this.getArea().toFixed(1)) + "";
			this.areaLabel.setText(msg);
		}
	}, {
		key: "raycast",
		value: function raycast(raycaster, intersects) {

			for (var i = 0; i < this.points.length; i++) {
				var sphere = this.spheres[i];

				sphere.raycast(raycaster, intersects);
			}

			// recalculate distances because they are not necessarely correct
			// for scaled objects.
			// see https://github.com/mrdoob/three.js/issues/5827
			// TODO: remove this once the bug has been fixed
			for (var _i2 = 0; _i2 < intersects.length; _i2++) {
				var I = intersects[_i2];
				I.distance = raycaster.ray.origin.distanceTo(I.point);
			}
			intersects.sort(function (a, b) {
				return a.distance - b.distance;
			});
		}
	}, {
		key: "showCoordinates",
		get: function get() {
			return this._showCoordinates;
		},
		set: function set(value) {
			this._showCoordinates = value;
			this.update();
		}
	}, {
		key: "showAngles",
		get: function get() {
			return this._showAngles;
		},
		set: function set(value) {
			this._showAngles = value;
			this.update();
		}
	}, {
		key: "showArea",
		get: function get() {
			return this._showArea;
		},
		set: function set(value) {
			this._showArea = value;
			this.update();
		}
	}, {
		key: "closed",
		get: function get() {
			return this._closed;
		},
		set: function set(value) {
			this._closed = value;
			this.update();
		}
	}, {
		key: "showDistances",
		get: function get() {
			return this._showDistances;
		},
		set: function set(value) {
			this._showDistances = value;
			this.update();
		}
	}]);

	return _class;
}();
"use strict";

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

Potree.MeasuringTool = function () {
	function _class(renderer) {
		_classCallCheck(this, _class);

		this.enabled = false;

		this.scene = null;
		this.renderer = renderer;
		this.domElement = renderer.domElement;
		this.mouse = { x: 0, y: 0 };

		this.STATE = {
			DEFAULT: 0,
			INSERT: 1
		};

		this.state = this.STATE.DEFAULT;

		this.activeMeasurement = null;
		this.sceneMeasurement = new THREE.Scene();
		this.sceneRoot = new THREE.Object3D();
		this.sceneMeasurement.add(this.sceneRoot);

		this.light = new THREE.DirectionalLight(0xffffff, 1);
		this.light.position.set(0, 0, 10);
		this.light.lookAt(new THREE.Vector3(0, 0, 0));
		this.sceneMeasurement.add(this.light);

		this.hoveredElement = null;
		this.dispatcher = new THREE.EventDispatcher();

		var onClick = function (event) {
			if (this.state === this.STATE.INSERT) {
				var point = this.getMousePointCloudIntersection();
				if (point) {
					var pos = point.position.clone();

					this.activeMeasurement.addMarker(pos);

					var _event = {
						type: 'newpoint',
						position: pos.clone()
					};
					this.dispatcher.dispatchEvent(_event);

					if (this.activeMeasurement.points.length > this.activeMeasurement.maxMarkers) {
						this.finishInsertion();
					}
				}
			}
		}.bind(this);

		var onMouseMove = function (event) {
			if (!this.scene) {
				return;
			}

			var rect = this.domElement.getBoundingClientRect();
			this.mouse.x = (event.clientX - rect.left) / this.domElement.clientWidth * 2 - 1;
			this.mouse.y = -((event.clientY - rect.top) / this.domElement.clientHeight) * 2 + 1;

			//console.log(this.mouse);

			if (this.dragstart) {
				var arg = {
					type: "drag",
					event: event,
					tool: this
				};
				this.dragstart.object.dispatchEvent(arg);
			} else if (this.state == this.STATE.INSERT && this.activeMeasurement) {
				var point = this.getMousePointCloudIntersection();

				if (point) {
					//let position = point.position;
					var lastIndex = this.activeMeasurement.points.length - 1;
					//this.activeMeasurement.setPosition(lastIndex, position);
					this.activeMeasurement.setMarker(lastIndex, point);
				}
			} else {
				var I = this.getHoveredElement();

				if (I) {

					I.object.dispatchEvent({ type: "move", target: I.object, event: event });

					if (this.hoveredElement && this.hoveredElement !== I.object) {
						this.hoveredElement.dispatchEvent({ type: "leave", target: this.hoveredElement, event: event });
					}

					this.hoveredElement = I.object;
				} else {

					if (this.hoveredElement) {
						this.hoveredElement.dispatchEvent({ type: "leave", target: this.hoveredElement, event: event });
					}

					this.hoveredElement = null;
				}
			}
		}.bind(this);

		var onRightClick = function (event) {
			if (this.state == this.STATE.INSERT) {
				this.finishInsertion();
			}
		}.bind(this);

		var onMouseDown = function (event) {
			if (event.which === 1) {

				if (this.state !== this.STATE.DEFAULT) {
					event.stopImmediatePropagation();
				}

				var I = this.getHoveredElement();

				if (I) {

					this.dragstart = {
						object: I.object,
						sceneClickPos: I.point,
						sceneStartPos: this.sceneRoot.position.clone(),
						mousePos: { x: this.mouse.x, y: this.mouse.y }
					};

					event.stopImmediatePropagation();
				}
			} else if (event.which === 3) {
				onRightClick(event);
			}
		}.bind(this);

		var onDoubleClick = function (event) {

			// fix move event after double click
			// see: http://stackoverflow.com/questions/8125165/event-listener-for-dblclick-causes-event-for-mousemove-to-not-work-and-show-a-ci
			if (window.getSelection) {
				window.getSelection().removeAllRanges();
			} else if (document.selection) {
				document.selection.empty();
			}

			if (this.activeMeasurement && this.state === this.STATE.INSERT) {
				this.activeMeasurement.removeMarker(this.activeMeasurement.points.length - 1);
				this.finishInsertion();
				event.stopImmediatePropagation();
			}
		}.bind(this);

		var onMouseUp = function (event) {
			if (this.dragstart) {
				this.dragstart.object.dispatchEvent({ type: "drop", event: event });
				this.dragstart = null;
			}
		}.bind(this);

		this.domElement.addEventListener('click', onClick, false);
		this.domElement.addEventListener('dblclick', onDoubleClick, false);
		this.domElement.addEventListener('mousemove', onMouseMove, false);
		this.domElement.addEventListener('mousedown', onMouseDown, false);
		this.domElement.addEventListener('mouseup', onMouseUp, true);
	}

	_createClass(_class, [{
		key: "setScene",
		value: function setScene(scene) {
			var _this = this;

			this.scene = scene;
			this.measurements = this.scene.measurements;

			this.activeMeasurement = null;
			this.sceneMeasurement = new THREE.Scene();
			this.sceneRoot = new THREE.Object3D();
			this.sceneMeasurement.add(this.sceneRoot);

			this.light = new THREE.DirectionalLight(0xffffff, 1);
			this.light.position.set(0, 0, 10);
			this.light.lookAt(new THREE.Vector3(0, 0, 0));
			this.sceneMeasurement.add(this.light);

			var _iteratorNormalCompletion = true;
			var _didIteratorError = false;
			var _iteratorError = undefined;

			try {
				for (var _iterator = this.scene.measurements[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
					var measurement = _step.value;

					this.sceneMeasurement.add(measurement.sceneNode);
				}
			} catch (err) {
				_didIteratorError = true;
				_iteratorError = err;
			} finally {
				try {
					if (!_iteratorNormalCompletion && _iterator.return) {
						_iterator.return();
					}
				} finally {
					if (_didIteratorError) {
						throw _iteratorError;
					}
				}
			}

			this.scene.addEventListener("measurement_added", function (e) {
				if (_this.scene === e.scene) {
					_this.sceneMeasurement.add(e.measurement.sceneNode);
				}
			});

			this.scene.addEventListener("measurement_removed", function (e) {
				if (_this.scene === e.scene) {
					_this.sceneMeasurement.remove(e.measurement.sceneNode);
				}
			});
		}
	}, {
		key: "addEventListener",
		value: function addEventListener(type, callback) {
			this.dispatcher.addEventListener(type, callback);
		}
	}, {
		key: "getHoveredElement",
		value: function getHoveredElement() {

			var vector = new THREE.Vector3(this.mouse.x, this.mouse.y, 0.5);
			vector.unproject(this.scene.camera);

			var raycaster = new THREE.Raycaster();
			raycaster.ray.set(this.scene.camera.position, vector.sub(this.scene.camera.position).normalize());

			var spheres = [];
			for (var i = 0; i < this.measurements.length; i++) {
				var m = this.measurements[i];

				for (var j = 0; j < m.spheres.length; j++) {
					spheres.push(m.spheres[j]);
				}
			}

			var intersections = raycaster.intersectObjects(spheres, true);
			if (intersections.length > 0) {
				return intersections[0];
			} else {
				return false;
			}
		}
	}, {
		key: "getMousePointCloudIntersection",
		value: function getMousePointCloudIntersection() {
			var vector = new THREE.Vector3(this.mouse.x, this.mouse.y, 0.5);
			vector.unproject(this.scene.camera);

			var direction = vector.sub(this.scene.camera.position).normalize();
			var ray = new THREE.Ray(this.scene.camera.position, direction);

			var pointClouds = [];
			this.scene.scenePointCloud.traverse(function (object) {
				if (object instanceof Potree.PointCloudOctree || object instanceof Potree.PointCloudArena4D) {
					pointClouds.push(object);
				}
			});

			var closestPoint = null;
			var closestPointDistance = null;

			for (var i = 0; i < pointClouds.length; i++) {
				var pointcloud = pointClouds[i];
				var point = pointcloud.pick(this.renderer, this.scene.camera, ray);

				if (!point) {
					continue;
				}

				var distance = this.scene.camera.position.distanceTo(point.position);

				if (!closestPoint || distance < closestPointDistance) {
					closestPoint = point;
					closestPointDistance = distance;
				}
			}

			return closestPoint ? closestPoint : null;
		}
	}, {
		key: "startInsertion",
		value: function startInsertion() {
			var args = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

			this.state = this.STATE.INSERT;

			var showDistances = typeof args.showDistances != "undefined" ? args.showDistances : true;
			var showArea = typeof args.showArea != "undefined" ? args.showArea : false;
			var showAngles = typeof args.showAngles != "undefined" ? args.showAngles : false;
			var closed = typeof args.closed != "undefined" ? args.closed : false;
			var showCoordinates = typeof args.showCoordinates != "undefined" ? args.showCoordinates : false;
			var maxMarkers = args.maxMarkers || Number.MAX_SAFE_INTEGER;

			var measurement = new Potree.Measure();
			measurement.showDistances = showDistances;
			measurement.showArea = showArea;
			measurement.showAngles = showAngles;
			measurement.closed = closed;
			measurement.showCoordinates = showCoordinates;
			measurement.maxMarkers = maxMarkers;
			measurement.addMarker(new THREE.Vector3(Infinity, Infinity, Infinity));

			this.scene.addMeasurement(measurement);
			this.activeMeasurement = measurement;

			return this.activeMeasurement;
		}
	}, {
		key: "finishInsertion",
		value: function finishInsertion() {
			this.activeMeasurement.removeMarker(this.activeMeasurement.points.length - 1);

			var event = {
				type: "insertion_finished",
				measurement: this.activeMeasurement
			};
			this.dispatcher.dispatchEvent(event);

			this.activeMeasurement = null;
			this.state = this.STATE.DEFAULT;
		}
	}, {
		key: "update",
		value: function update() {
			if (!this.scene) {
				return;
			}

			var measurements = [];
			for (var i = 0; i < this.measurements.length; i++) {
				measurements.push(this.measurements[i]);
			}
			if (this.activeMeasurement) {
				measurements.push(this.activeMeasurement);
			}

			// make sizes independant of distance and fov
			for (var _i = 0; _i < measurements.length; _i++) {
				var measurement = measurements[_i];

				// spheres
				for (var j = 0; j < measurement.spheres.length; j++) {
					var sphere = measurement.spheres[j];

					var _distance = this.scene.camera.position.distanceTo(sphere.getWorldPosition());
					var _pr = Potree.utils.projectedRadius(1, this.scene.camera.fov * Math.PI / 180, _distance, this.renderer.domElement.clientHeight);
					var _scale = 15 / _pr;
					sphere.scale.set(_scale, _scale, _scale);
				}

				// edgeLabels
				for (var _j = 0; _j < measurement.edgeLabels.length; _j++) {
					var label = measurement.edgeLabels[_j];

					var _distance2 = this.scene.camera.position.distanceTo(label.getWorldPosition());
					var _pr2 = Potree.utils.projectedRadius(1, this.scene.camera.fov * Math.PI / 180, _distance2, this.renderer.domElement.clientHeight);
					var _scale2 = 70 / _pr2;
					label.scale.set(_scale2, _scale2, _scale2);
				}

				// angle labels
				for (var _j2 = 0; _j2 < measurement.edgeLabels.length; _j2++) {
					var _label = measurement.angleLabels[_j2];

					var _distance3 = this.scene.camera.position.distanceTo(_label.getWorldPosition());
					var _pr3 = Potree.utils.projectedRadius(1, this.scene.camera.fov * Math.PI / 180, _distance3, this.renderer.domElement.clientHeight);
					var _scale3 = 70 / _pr3;
					_label.scale.set(_scale3, _scale3, _scale3);
				}

				// coordinate labels
				for (var _j3 = 0; _j3 < measurement.coordinateLabels.length; _j3++) {
					var _label2 = measurement.coordinateLabels[_j3];
					var _sphere = measurement.spheres[_j3];
					var point = measurement.points[_j3];

					var _distance4 = this.scene.camera.position.distanceTo(_sphere.getWorldPosition());

					var screenPos = _sphere.getWorldPosition().clone().project(this.scene.camera);
					screenPos.x = Math.round((screenPos.x + 1) * this.renderer.domElement.clientWidth / 2), screenPos.y = Math.round((-screenPos.y + 1) * this.renderer.domElement.clientHeight / 2);
					screenPos.z = 0;
					screenPos.y -= 30;

					var labelPos = new THREE.Vector3(screenPos.x / this.renderer.domElement.clientWidth * 2 - 1, -(screenPos.y / this.renderer.domElement.clientHeight) * 2 + 1, 0.5);
					labelPos.unproject(this.scene.camera);

					var direction = labelPos.sub(this.scene.camera.position).normalize();
					labelPos = new THREE.Vector3().addVectors(this.scene.camera.position, direction.multiplyScalar(_distance4));

					_label2.position.copy(labelPos);

					var _pr4 = Potree.utils.projectedRadius(1, this.scene.camera.fov * Math.PI / 180, _distance4, this.renderer.domElement.clientHeight);
					var _scale4 = 70 / _pr4;
					_label2.scale.set(_scale4, _scale4, _scale4);

					//let geoCoord = point.position;
					//let txt = Potree.utils.addCommas(geoCoord.x.toFixed(2)) + " / ";
					//txt += Potree.utils.addCommas((geoCoord.y).toFixed(2)) + " / ";
					//txt += Potree.utils.addCommas(geoCoord.z.toFixed(2));
					//label.setText(txt);
				}

				// areaLabel
				var distance = this.scene.camera.position.distanceTo(measurement.areaLabel.getWorldPosition());
				var pr = Potree.utils.projectedRadius(1, this.scene.camera.fov * Math.PI / 180, distance, this.renderer.domElement.clientHeight);
				var scale = 80 / pr;
				measurement.areaLabel.scale.set(scale, scale, scale);
			}

			this.light.position.copy(this.scene.camera.position);
			this.light.lookAt(this.scene.camera.getWorldDirection().add(this.scene.camera.position));
		}
	}, {
		key: "render",
		value: function render() {
			this.update();
			this.renderer.render(this.sceneMeasurement, this.scene.camera);
		}
	}]);

	return _class;
}();
"use strict";

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

Potree.Profile = function () {
	function _class() {
		_classCallCheck(this, _class);

		this.sceneNode = new THREE.Object3D();
		this.dispatcher = new THREE.EventDispatcher();

		this.points = [];
		this.spheres = [];
		this.edges = [];
		this.boxes = [];
		this.width = 1;
		this.height = 20;
		this._modifiable = true;

		this.sphereGeometry = new THREE.SphereGeometry(0.4, 10, 10);
		this.color = new THREE.Color(0xff0000);
		this.lineColor = new THREE.Color(0xff0000);
	}

	_createClass(_class, [{
		key: "createSphereMaterial",
		value: function createSphereMaterial() {
			var sphereMaterial = new THREE.MeshLambertMaterial({
				shading: THREE.SmoothShading,
				color: 0xff0000,
				depthTest: false,
				depthWrite: false });

			return sphereMaterial;
		}
	}, {
		key: "addMarker",
		value: function addMarker(point) {
			var _this = this;

			this.points.push(point);

			var sphere = new THREE.Mesh(this.sphereGeometry, this.createSphereMaterial());

			var moveEvent = function moveEvent(event) {
				sphere.material.emissive.setHex(0x888888);
			};

			var leaveEvent = function leaveEvent(event) {
				event.target.material.emissive.setHex(0x000000);
			};

			var dragEvent = function dragEvent(event) {
				var tool = event.tool;
				var dragstart = tool.dragstart;
				var mouse = tool.mouse;

				if (event.event.ctrlKey) {
					var mouseStart = new THREE.Vector3(dragstart.mousePos.x, dragstart.mousePos.y, 0);
					var mouseEnd = new THREE.Vector3(mouse.x, mouse.y, 0);
					var widthStart = dragstart.widthStart;

					var scale = 1 - 10 * (mouseStart.y - mouseEnd.y);
					scale = Math.max(0.01, scale);
					if (widthStart) {
						_this.setWidth(widthStart * scale);
					}
				} else {
					var _point = tool.getMousePointCloudIntersection.bind(tool)();

					if (_point) {
						var index = _this.spheres.indexOf(tool.dragstart.object);
						_this.setPosition(index, _point);
					}
				}

				event.event.stopImmediatePropagation();
			};

			var dropEvent = function dropEvent(event) {};

			sphere.addEventListener("mousemove", moveEvent);
			sphere.addEventListener("mouseleave", leaveEvent);
			sphere.addEventListener("mousedrag", dragEvent);
			sphere.addEventListener("drop", dropEvent);

			this.sceneNode.add(sphere);
			this.spheres.push(sphere);

			// edges & boxes
			if (this.points.length > 1) {

				var lineGeometry = new THREE.Geometry();
				lineGeometry.vertices.push(new THREE.Vector3(), new THREE.Vector3());
				lineGeometry.colors.push(this.lineColor, this.lineColor, this.lineColor);
				var lineMaterial = new THREE.LineBasicMaterial({
					vertexColors: THREE.VertexColors,
					linewidth: 2,
					transparent: true,
					opacity: 0.4
				});
				lineMaterial.depthTest = false;
				var edge = new THREE.Line(lineGeometry, lineMaterial);
				edge.visible = false;

				this.sceneNode.add(edge);
				this.edges.push(edge);

				var boxGeometry = new THREE.BoxGeometry(1, 1, 1);
				var boxMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.2 });
				var box = new THREE.Mesh(boxGeometry, boxMaterial);
				box.visible = false;

				this.sceneNode.add(box);
				this.boxes.push(box);
			}

			var event = {
				type: "marker_added",
				profile: this
			};
			this.dispatcher.dispatchEvent(event);

			this.setPosition(this.points.length - 1, point);
		}
	}, {
		key: "removeMarker",
		value: function removeMarker(index) {
			this.points.splice(index, 1);

			this.sceneNode.remove(this.spheres[index]);

			var edgeIndex = index === 0 ? 0 : index - 1;
			this.sceneNode.remove(this.edges[edgeIndex]);
			this.edges.splice(edgeIndex, 1);
			this.sceneNode.remove(this.boxes[edgeIndex]);
			this.boxes.splice(edgeIndex, 1);

			this.spheres.splice(index, 1);

			this.update();

			this.dispatcher.dispatchEvent({
				"type": "marker_removed",
				"profile": this
			});
		}
	}, {
		key: "setPosition",
		value: function setPosition(index, position) {
			var point = this.points[index];
			point.copy(position);

			var event = {
				type: 'marker_moved',
				profile: this,
				index: index,
				position: point.clone()
			};
			this.dispatcher.dispatchEvent(event);

			this.update();
		}
	}, {
		key: "setWidth",
		value: function setWidth(width) {
			this.width = width;

			var event = {
				type: 'width_changed',
				profile: this,
				width: width
			};
			this.dispatcher.dispatchEvent(event);

			this.update();
		}
	}, {
		key: "getWidth",
		value: function getWidth() {
			return this.width;
		}
	}, {
		key: "update",
		value: function update() {

			if (this.points.length === 0) {
				return;
			} else if (this.points.length === 1) {
				var point = this.points[0];
				this.spheres[0].position.copy(point);

				return;
			}

			var min = this.points[0].clone();
			var max = this.points[0].clone();
			var centroid = new THREE.Vector3();
			var lastIndex = this.points.length - 1;
			for (var i = 0; i <= lastIndex; i++) {
				var _point2 = this.points[i];
				var sphere = this.spheres[i];
				var leftIndex = i === 0 ? lastIndex : i - 1;
				var rightIndex = i === lastIndex ? 0 : i + 1;
				var leftVertex = this.points[leftIndex];
				var rightVertex = this.points[rightIndex];
				var leftEdge = this.edges[leftIndex];
				var rightEdge = this.edges[i];
				var leftBox = this.boxes[leftIndex];
				var rightBox = this.boxes[i];

				var leftEdgeLength = _point2.distanceTo(leftVertex);
				var rightEdgeLength = _point2.distanceTo(rightVertex);
				var leftEdgeCenter = new THREE.Vector3().addVectors(leftVertex, _point2).multiplyScalar(0.5);
				var rightEdgeCenter = new THREE.Vector3().addVectors(_point2, rightVertex).multiplyScalar(0.5);

				sphere.position.copy(_point2);

				if (this._modifiable) {
					sphere.visible = true;
				} else {
					sphere.visible = false;
				}

				if (leftEdge) {
					leftEdge.geometry.vertices[1].copy(_point2);
					leftEdge.geometry.verticesNeedUpdate = true;
					leftEdge.geometry.computeBoundingSphere();
				}

				if (rightEdge) {
					rightEdge.geometry.vertices[0].copy(_point2);
					rightEdge.geometry.verticesNeedUpdate = true;
					rightEdge.geometry.computeBoundingSphere();
				}

				if (leftBox) {
					var start = leftVertex;
					var end = _point2;
					var length = start.clone().setZ(0).distanceTo(end.clone().setZ(0));
					leftBox.scale.set(length, 1000000, this.width);
					leftBox.up.set(0, 0, 1);

					var center = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
					var diff = new THREE.Vector3().subVectors(end, start);
					var target = new THREE.Vector3(diff.y, -diff.x, 0);

					leftBox.position.set(0, 0, 0);
					leftBox.lookAt(target);
					leftBox.position.copy(center);
				}

				centroid.add(_point2);
				min.min(_point2);
				max.max(_point2);
			}
			centroid.multiplyScalar(1 / this.points.length);

			for (var i = 0; i < this.boxes.length; i++) {
				var box = this.boxes[i];

				box.position.z = min.z + (max.z - min.z) / 2;
			}
		}
	}, {
		key: "raycast",
		value: function raycast(raycaster, intersects) {

			for (var i = 0; i < this.points.length; i++) {
				var sphere = this.spheres[i];

				sphere.raycast(raycaster, intersects);
			}

			// recalculate distances because they are not necessarely correct
			// for scaled objects.
			// see https://github.com/mrdoob/three.js/issues/5827
			// TODO: remove this once the bug has been fixed
			for (var _i = 0; _i < intersects.length; _i++) {
				var I = intersects[_i];
				I.distance = raycaster.ray.origin.distanceTo(I.point);
			}
			intersects.sort(function (a, b) {
				return a.distance - b.distance;
			});
		}
	}, {
		key: "modifiable",
		get: function get() {
			return this._modifiable;
		},
		set: function set(value) {
			this._modifiable = value;
			this.update();
		}
	}]);

	return _class;
}();
"use strict";

Potree.ProfileTool = function (renderer) {

	var scope = this;
	this.enabled = false;

	this.scene = null;
	this.renderer = renderer;
	this.domElement = renderer.domElement;
	this.mouse = { x: 0, y: 0 };

	var STATE = {
		DEFAULT: 0,
		INSERT: 1
	};

	var state = STATE.DEFAULT;

	var sphereGeometry = new THREE.SphereGeometry(0.4, 10, 10);

	this.activeProfile = null;
	this.profiles = [];
	this.sceneProfile = new THREE.Scene();
	this.sceneRoot = new THREE.Object3D();
	this.sceneProfile.add(this.sceneRoot);

	this.light = new THREE.DirectionalLight(0xffffff, 1);
	this.light.position.set(0, 0, 10);
	this.light.lookAt(new THREE.Vector3(0, 0, 0));
	this.sceneProfile.add(this.light);

	this.hoveredElement = null;

	function createSphereMaterial() {
		var sphereMaterial = new THREE.MeshLambertMaterial({
			shading: THREE.SmoothShading,
			color: 0xff0000,
			ambient: 0xaaaaaa,
			depthTest: false,
			depthWrite: false });

		return sphereMaterial;
	};

	function onClick(event) {

		if (state === STATE.INSERT) {
			var I = scope.getMousePointCloudIntersection();
			if (I) {
				var pos = I.clone();

				if (scope.activeProfile.points.length === 1 && scope.activeProfile.width === null) {
					scope.activeProfile.setWidth(scope.scene.camera.position.distanceTo(pos) / 50);
				}

				scope.activeProfile.addMarker(pos);

				var event = {
					type: 'newpoint',
					position: pos.clone()
				};
				scope.dispatchEvent(event);
			}
		}
	};

	function onMouseMove(event) {
		if (!scope.scene) {
			return;
		}

		var rect = scope.domElement.getBoundingClientRect();
		scope.mouse.x = (event.clientX - rect.left) / scope.domElement.clientWidth * 2 - 1;
		scope.mouse.y = -((event.clientY - rect.top) / scope.domElement.clientHeight) * 2 + 1;

		if (scope.dragstart) {
			var arg = {
				type: "mousedrag",
				event: event,
				tool: scope
			};
			scope.dragstart.object.dispatchEvent(arg);
		} else if (state == STATE.INSERT && scope.activeProfile) {
			var I = scope.getMousePointCloudIntersection();

			if (I) {

				var lastIndex = scope.activeProfile.points.length - 1;
				scope.activeProfile.setPosition(lastIndex, I);
			}
		} else {
			var I = getHoveredElement();

			if (I) {

				I.object.dispatchEvent({ type: "mousemove", target: I.object, event: event });

				if (scope.hoveredElement && scope.hoveredElement !== I.object) {
					scope.hoveredElement.dispatchEvent({ type: "mouseleave", target: scope.hoveredElement, event: event });
				}

				scope.hoveredElement = I.object;
			} else {

				if (scope.hoveredElement) {
					scope.hoveredElement.dispatchEvent({ type: "mouseleave", target: scope.hoveredElement, event: event });
				}

				scope.hoveredElement = null;
			}
		}
	};

	function onRightClick(event) {
		if (state == STATE.INSERT) {
			scope.finishInsertion();
		}
	}

	function onMouseDown(event) {

		if (state !== STATE.DEFAULT) {
			event.stopImmediatePropagation();
		}

		if (event.which === 1) {

			var I = getHoveredElement();

			if (I) {

				var widthStart = null;
				for (var i = 0; i < scope.profiles.length; i++) {
					var profile = scope.profiles[i];
					for (var j = 0; j < profile.spheres.length; j++) {
						var sphere = profile.spheres[j];

						if (sphere === I.object) {
							widthStart = profile.width;
						}
					}
				}

				scope.dragstart = {
					object: I.object,
					sceneClickPos: I.point,
					sceneStartPos: scope.sceneRoot.position.clone(),
					mousePos: { x: scope.mouse.x, y: scope.mouse.y },
					widthStart: widthStart
				};
				event.stopImmediatePropagation();
			}
		} else if (event.which === 3) {
			onRightClick(event);
		}
	}

	function onDoubleClick(event) {

		// fix move event after double click
		// see: http://stackoverflow.com/questions/8125165/event-listener-for-dblclick-causes-event-for-mousemove-to-not-work-and-show-a-ci
		if (window.getSelection) {
			window.getSelection().removeAllRanges();
		} else if (document.selection) {
			document.selection.empty();
		}

		if (scope.activeProfile && state === STATE.INSERT) {
			scope.activeProfile.removeMarker(scope.activeProfile.points.length - 1);
			scope.finishInsertion();
			event.stopImmediatePropagation();
		}
	}

	function onMouseUp(event) {

		if (scope.dragstart) {
			scope.dragstart.object.dispatchEvent({ type: "drop", event: event });
			scope.dragstart = null;
		}
	}

	this.setScene = function (scene) {
		var _this = this;

		this.scene = scene;
		this.profiles = this.scene.profiles;

		this.activeProfile = null;
		this.sceneProfile = new THREE.Scene();
		this.sceneRoot = new THREE.Object3D();
		this.sceneProfile.add(this.sceneRoot);

		this.light = new THREE.DirectionalLight(0xffffff, 1);
		this.light.position.set(0, 0, 10);
		this.light.lookAt(new THREE.Vector3(0, 0, 0));
		this.sceneProfile.add(this.light);

		var _iteratorNormalCompletion = true;
		var _didIteratorError = false;
		var _iteratorError = undefined;

		try {
			for (var _iterator = this.scene.profiles[Symbol.iterator](), _step; !(_iteratorNormalCompletion = (_step = _iterator.next()).done); _iteratorNormalCompletion = true) {
				var profile = _step.value;

				this.sceneProfile.add(profile.sceneNode);
			}
		} catch (err) {
			_didIteratorError = true;
			_iteratorError = err;
		} finally {
			try {
				if (!_iteratorNormalCompletion && _iterator.return) {
					_iterator.return();
				}
			} finally {
				if (_didIteratorError) {
					throw _iteratorError;
				}
			}
		}

		var onProfileAdded = function onProfileAdded(e) {
			if (_this.scene === e.scene) {
				_this.sceneProfile.add(e.profile.sceneNode);
			}
		};

		var onProfileRemoved = function onProfileRemoved(e) {
			if (_this.scene === e.scene) {
				_this.sceneProfile.remove(e.profile.sceneNode);
			}
		};

		// TODO make sure not du add the same listeners twice
		scene.addEventListener("profile_added", onProfileAdded);
		scene.addEventListener("profile_removed", onProfileRemoved);
	};

	function getHoveredElement() {

		var vector = new THREE.Vector3(scope.mouse.x, scope.mouse.y, 0.5);
		vector.unproject(scope.scene.camera);

		var raycaster = new THREE.Raycaster();
		raycaster.ray.set(scope.scene.camera.position, vector.sub(scope.scene.camera.position).normalize());

		var intersections = raycaster.intersectObjects(scope.profiles);

		if (intersections.length > 0) {
			return intersections[0];
		} else {
			return false;
		}
	};

	this.getMousePointCloudIntersection = function () {
		var vector = new THREE.Vector3(scope.mouse.x, scope.mouse.y, 0.5);
		vector.unproject(scope.scene.camera);

		var direction = vector.sub(scope.scene.camera.position).normalize();
		var ray = new THREE.Ray(scope.scene.camera.position, direction);

		var pointClouds = [];
		scope.scene.scenePointCloud.traverse(function (object) {
			if (object instanceof Potree.PointCloudOctree || object instanceof Potree.PointCloudArena4D) {
				pointClouds.push(object);
			}
		});

		var closestPoint = null;
		var closestPointDistance = null;

		for (var i = 0; i < pointClouds.length; i++) {
			var pointcloud = pointClouds[i];
			var point = pointcloud.pick(scope.renderer, scope.scene.camera, ray, {
				pickOutsideClipRegion: true
			});

			if (!point) {
				continue;
			}

			var distance = scope.scene.camera.position.distanceTo(point.position);

			if (!closestPoint || distance < closestPointDistance) {
				closestPoint = point;
				closestPointDistance = distance;
			}
		}

		return closestPoint ? closestPoint.position : null;
	};

	this.startInsertion = function () {
		var args = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

		state = STATE.INSERT;

		var clip = args.clip || false;
		var width = args.width || null;

		var profile = new Potree.Profile();
		profile.clip = clip;
		profile.setWidth(width);
		profile.addMarker(new THREE.Vector3(0, 0, 0));

		this.scene.addProfile(profile);
		this.activeProfile = profile;

		return this.activeProfile;
	};

	this.finishInsertion = function () {
		this.activeProfile.removeMarker(this.activeProfile.points.length - 1);

		var event = {
			type: "insertion_finished",
			profile: this.activeProfile
		};
		this.dispatchEvent(event);

		this.activeProfile = null;
		state = STATE.DEFAULT;
	};

	this.addProfile = function (profile) {
		this.profiles.push(profile);
		this.sceneProfile.add(profile);
		profile.update();

		this.dispatchEvent({ "type": "profile_added", profile: profile });
		profile.addEventListener("marker_added", function (event) {
			scope.dispatchEvent(event);
		});
		profile.addEventListener("marker_removed", function (event) {
			scope.dispatchEvent(event);
		});
		profile.addEventListener("marker_moved", function (event) {
			scope.dispatchEvent(event);
		});
		profile.addEventListener("width_changed", function (event) {
			scope.dispatchEvent(event);
		});
	};

	this.reset = function () {
		for (var i = this.profiles.length - 1; i >= 0; i--) {
			var profile = this.profiles[i];
			this.removeProfile(profile);
		}
	};

	this.update = function () {

		for (var i = 0; i < this.profiles.length; i++) {
			var profile = this.profiles[i];
			for (var j = 0; j < profile.spheres.length; j++) {
				var sphere = profile.spheres[j];

				var distance = scope.scene.camera.position.distanceTo(sphere.getWorldPosition());
				var pr = Potree.utils.projectedRadius(1, scope.scene.camera.fov * Math.PI / 180, distance, renderer.domElement.clientHeight);
				var scale = 15 / pr;
				sphere.scale.set(scale, scale, scale);
			}
		}

		this.light.position.copy(this.scene.camera.position);
		this.light.lookAt(this.scene.camera.getWorldDirection().add(this.scene.camera.position));
	};

	this.render = function () {
		this.update();
		renderer.render(this.sceneProfile, this.scene.camera);
	};

	this.domElement.addEventListener('click', onClick, false);
	this.domElement.addEventListener('dblclick', onDoubleClick, false);
	this.domElement.addEventListener('mousemove', onMouseMove, false);
	this.domElement.addEventListener('mousedown', onMouseDown, false);
	this.domElement.addEventListener('mouseup', onMouseUp, true);
};

Potree.ProfileTool.prototype = Object.create(THREE.EventDispatcher.prototype);