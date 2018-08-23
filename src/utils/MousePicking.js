const getMousePointCloudIntersection = (mouse, camera, viewer, pointclouds, params = {}) => {
	let renderer = viewer.renderer;

	let nmouse = {
		x: (mouse.x / renderer.domElement.clientWidth) * 2 - 1,
		y: -(mouse.y / renderer.domElement.clientHeight) * 2 + 1
	};

	let pickParams = {};

	if (params.pickClipped) {
		pickParams.pickClipped = params.pickClipped;
	}

	pickParams.x = mouse.x;
	pickParams.y = renderer.domElement.clientHeight - mouse.y;

	let raycaster = new THREE.Raycaster();
	raycaster.setFromCamera(nmouse, camera);
	let ray = raycaster.ray;

	let selectedPointcloud = null;
	let closestDistance = Infinity;
	let closestIntersection = null;
	let closestPoint = null;

	for (let pointcloud of pointclouds) {
		let point = pointcloud.pick(viewer, camera, ray, pickParams);

		if (!point) {
			continue;
		}

		let distance = camera.position.distanceTo(point.position);

		if (distance < closestDistance) {
			closestDistance = distance;
			selectedPointcloud = pointcloud;
			closestIntersection = point.position;
			closestPoint = point;
		}
	}

	if (selectedPointcloud) {
		return {
			location: closestIntersection,
			distance: closestDistance,
			pointcloud: selectedPointcloud,
			point: closestPoint
		};
	} else {
		return null;
	}
}

export default getMousePointCloudIntersection;