import * as THREE from "three";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import * as SunCalc from "suncalc";
import { vec3, mat4 } from "gl-matrix";

let target;

// if something fishy happens to the local storage, errors or load could render the game unplayable
// use try-catch to prevent this
try {
	target = JSON.parse(localStorage.getItem("position"));
} catch {}
target = target || { lng: 9.142202119898826, lat: 49.97692244755174 };

const map = new maplibregl.Map({
	container: "map",
	center: target,
	minZoom: 16,
	maxZoom: 21,
	zoom: 20,
	pitch: 45,
	minPitch: 1,
	antialias: true,
	dragPan: false,
	scrollZoom: { around: "center" },
	touchZoomRotate: { around: "center" },
	doubleClickZoom: false,
	// key leakage is part of maptiler's ecosystem *shrug*
	// their "fix" is to allow restricting keys to certain 'Origin' headers ("pinky promise uwu")
	// honestly api keys are cringe anyway
	style:
		"https://api.maptiler.com/maps/streets/style.json?key=DOnvuOySyPyQM83lAx0a",
	/*{
		version: 8,
		sources: {
			osm: {
				type: "raster",
				tiles: ["https://a.tile.openstreetmap.org/{z}/{x}/{y}.png"],
				tileSize: 256,
				maxzoom: 20,
			},
		},
		layers: [
			{
				id: "osm",
				type: "raster",
				source: "osm",
			},
		],
	},*/
});

// hack. otherwise, zooming/rotating won't work while moving
map.stop = () => {};

// https://github.com/maplibre/maplibre-gl-js/discussions/1521
map.getCameraPosition = () => {
	const pitch = map.transform._pitch;
	const altitude = Math.cos(pitch) * map.transform.cameraToCenterDistance;
	const latOffset = Math.tan(pitch) * map.transform.cameraToCenterDistance;
	const latPosPointInPixels = map.transform.centerPoint.add(
		new maplibregl.Point(0, latOffset),
	);
	const latLong = map.transform.pointLocation(latPosPointInPixels);
	const verticalScaleConstant =
		map.transform.worldSize /
		(2 * Math.PI * 6378137 * Math.abs(Math.cos(latLong.lat * (Math.PI / 180))));
	const altitudeInMeters = altitude / verticalScaleConstant;
	return {
		lng: latLong.lng,
		lat: latLong.lat,
		altitude: altitudeInMeters,
		pitch: (pitch * 180) / Math.PI,
	};
};

const clamp = (min, max, x) => Math.min(max, Math.max(min, x));

const camera = new THREE.PerspectiveCamera();
const scene = new THREE.Scene();

const marker = new THREE.Group();

new SVGLoader().load("marker.svg", (data) => {
	const material = new THREE.MeshBasicMaterial({
		color: new THREE.Color(0),
		side: THREE.DoubleSide,
		depthWrite: true,
		transparent: false,
	});

	for (const shape of data.paths.flatMap(SVGLoader.createShapes)) {
		const geometry = new THREE.ShapeGeometry(shape);
		const mesh = new THREE.Mesh(geometry, material);
		mesh.scale.setScalar(1 / 1792);
		mesh.position.set(-0.5, (1536 - 118.237) / 1792, 0);
		//mesh.position.set(-0.5, 0, (1536 - 118.237) / 1792);
		mesh.rotateX(Math.PI);
		//mesh.rotateX(-Math.PI/2);
		marker.add(mesh);
	}

	marker.scale.setScalar(50);
	//marker.on("click", console.log);
	//scene.add(marker);
});

const mapToMerc = maplibregl.MercatorCoordinate.fromLngLat;

const mercToThree = (pos, center = mapToMerc(map.getCenter(), 0)) => {
	return new THREE.Vector3(
		pos.x - center.x,
		pos.z - center.z,
		pos.y - center.y,
	).divideScalar(center.meterInMercatorCoordinateUnits());
};

const mapToThree = (lngLat, altitude) => {
	return mercToThree(mapToMerc(lngLat, altitude));
};

/*new THREE.FBXLoader().load(
	"raphtalia.fbx",
	((model) => {
		model.traverse((child) => {
			if (child.isMesh) {
				// child.material.color = new THREE.Color(0xffffff);
				// delete child.material.color;
				(child.material.isMaterial ? [child.material] : child.material)
					.forEach(m => {
						m.castShadow = true;
					})

				child.castShadow = true;
			}
		});
		this.scene.add(model);
		player = model;
		update(target);
	}).bind(this)
);*/

const enableShadow = (model) => {
	model.traverse((child) => {
		if (child.isMesh) {
			(child.material.isMaterial ? [child.material] : child.material).forEach(
				(m) => {
					m.castShadow = true;
				},
			);

			child.castShadow = true;
		}
	});
};

let player;
{
	const path = "mei/"; // jasper/
	const scale = 3.0; // 1.5

	new GLTFLoader()
		.setPath(path)
		.setResourcePath(path)
		.load("scene.gltf", (gltf) => {
			player = gltf;

			enableShadow(player.scene);
			player.scene.scale.setScalar(scale);

			player.clock = new THREE.Clock();
			player.mixer = new THREE.AnimationMixer(player.scene);
			player.walk = player.mixer.clipAction(player.animations[0]);

			scene.add(player.scene);
		});
}

// shadow plane
{
	const geometry = new THREE.PlaneGeometry(60, 60);
	geometry.lookAt(new THREE.Vector3(0, 1, 0));

	const material = new THREE.ShadowMaterial();
	material.opacity = 0.3;

	const plane = new THREE.Mesh(geometry, material);
	plane.receiveShadow = true;
	// plane.position.set(0, 0, 0.01);
	scene.add(plane);
}

// animated circle around player
{
	const geometry = new THREE.CircleGeometry(7, 64);
	geometry.lookAt(new THREE.Vector3(0, 1, 0));

	const material = new THREE.MeshBasicMaterial({ color: 0xbebab6 });
	material.transparent = true;

	const circle = new THREE.Mesh(geometry, material);
	circle.position.set(0, 0.01, 0);
	scene.add(circle);

	const clock = new THREE.Clock();

	let t = 0.0;
	const animate = () => {
		const ph = [0.75, 0.9, 1.25];
		t = (t + (clock.getDelta() * ph[2]) / 5) % ph[2];

		const rlerp = (min, max, x) => clamp(0, 1, (x - min) / (max - min));
		const pow = Math.pow;

		circle.scale.setScalar(pow(rlerp(ph[0], ph[1], t), 2.0));
		material.opacity = pow(1 - rlerp(ph[1], ph[2], t), 2.0) * 0.8;

		requestAnimationFrame(animate);
	};

	animate();
}

class Celestial extends THREE.DirectionalLight {
	constructor(color, intensity, positionFunc) {
		super(color, intensity);

		this.castShadow = true;
		this.shadow.mapSize.width = 1024;
		this.shadow.mapSize.height = 1024;

		const frustumSize = 15;
		this.shadow.camera = new THREE.OrthographicCamera(
			-frustumSize / 2,
			frustumSize / 2,
			frustumSize / 2,
			-frustumSize / 2,
			1,
			50,
		);

		this.positionFunc = positionFunc;
		this.update();

		//scene.add(new THREE.CameraHelper(this.shadow.camera));
		scene.add(this);

		this.time = 23;
		addEventListener(
			"keypress",
			((evt) => {
				switch (evt.key) {
					case "h":
						this.time += 1;
						break;
					case "l":
						this.time -= 1;
						break;
					default:
						return;
				}
				evt.preventDefault();
			}).bind(this),
		);
	}

	update() {
		const pos = map.getCenter();
		const p = this.positionFunc(
			new Date(this.time * 1000 * 60 * 10),
			pos.lat,
			pos.lng,
		);

		p.altitude = (p.altitude + Math.PI * 2) % (Math.PI * 2);
		this.visible =
			p.altitude > Math.PI * 0.05 && p.altitude < Math.PI * (1 - 0.05);

		this.position
			.set(1, 0, 0)
			.applyEuler(new THREE.Euler(0, p.altitude, p.azimuth))
			.multiplyScalar(5);

		this.shadow.camera.position.copy(this.position);
		this.shadow.camera.lookAt(scene.position);
	}
}

scene.add(new THREE.AmbientLight(0xffffff, 0.8));

const sun = new Celestial(0xffffff, 0.4, SunCalc.getPosition);
// const moon = new Celestial(0x506886, 0.4, SunCalc.getMoonPosition);

setInterval(() => {
	sun.update();
	// moon.update();
}, 10);

const renderer = new THREE.WebGLRenderer({
	canvas: map.getCanvas(),
	context: map.painter.context.gl,
	antialias: true,
});
renderer.shadowMap.enabled = true;
// renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.autoClear = false;

const info = document.body.appendChild(document.createElement("span"));
info.style.position = "absolute";
info.style.zIndex = 5;
info.style.color = "green";

const render = (gl, mercViewProj) => {
	if (player) player.mixer.update(player.clock.getDelta());

	const camMap = map.getCameraPosition();
	const camMerc = mapToMerc(camMap, camMap.altitude);
	const cam = mercToThree(camMerc);

	const mercViewProjI = mat4.invert([], mercViewProj);

	const depthNCDtoThree = (depth) => {
		const [x, y, z] = vec3.transformMat4([], [0, 0, depth], mercViewProjI);
		return mercToThree({ x, y, z }, camMerc).length();
	};

	camera.aspect = innerWidth / innerHeight;
	camera.fov = map.transform.fov;
	camera.near = depthNCDtoThree(-1);
	camera.far = depthNCDtoThree(+1);
	camera.updateProjectionMatrix();

	camera.position.copy(cam);
	camera.lookAt(scene.position);

	cam.y = 0;
	marker.lookAt(cam);

	renderer.resetState();
	renderer.render(scene, camera);
	map.triggerRepaint();
};

map.on("style.load", () => {
	map.addLayer(
		{
			id: "3d-model",
			type: "custom",
			renderingMode: "3d",
			render,
		},
		"building-3d",
	);
});

addEventListener("resize", () => {
	renderer.setSize(innerWidth, innerHeight);
});

let playerAnimDuration = 0;
{
	const clock = new THREE.Clock();

	const animate = () => {
		requestAnimationFrame(animate);

		const dt = clock.getDelta();

		if (playerAnimDuration <= 0) return;

		const lerp = (a, b, x) => a * (1 - x) + b * x;
		const x = Math.min(dt / playerAnimDuration, 1);

		const center = map.getCenter();
		center.lng = lerp(center.lng, target.lng, x);
		center.lat = lerp(center.lat, target.lat, x);

		playerAnimDuration -= dt;

		if (playerAnimDuration <= 0) player.walk.stop();

		map.setCenter(center);
	};

	animate();
}

const clock = new THREE.Clock();
clock.getDelta();

const setTarget = (pos) => {
	const dt = clock.getDelta();

	if (player) {
		player.scene.lookAt(mapToThree(pos));
		player.walk.play();
	}

	playerAnimDuration = Math.min(dt, 1.5);
	localStorage.setItem("position", JSON.stringify((target = pos)));
};

const watchGeo = navigator.geolocation.watchPosition(
	({ coords: { longitude: lng, latitude: lat } }) => {
		const pos = { lng, lat };
		setTarget(pos);
	},
	(err) => {
		// todo: err.message;
		navigator.geolocation.clearWatch(watchGeo);

		const click = (evt) => {
			setTarget(evt.lngLat);
		};

		map.on("click", click);
		map.on("touched", click);
	},
	{
		enableHighAccuracy: true,
	},
);
