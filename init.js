import * as THREE from "three";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import * as SunCalc from "suncalc";
import Color from "colorjs.io";
import { yays, fireworks, models, markers } from "./assets.json";

// if something fishy happens to the local storage, errors on load could render the game unplayable
// use try-catch to prevent this
const storageParse = (item) => {
	try {
		return JSON.parse(localStorage.getItem(item));
	} catch {}
};

let target = storageParse("position") || {
	lng: 9.142202119898826,
	lat: 49.97692244755174,
};
let completed = storageParse("completed") || {};
const enable3d = localStorage.getItem("enable3d") != "false";
let forceTouchControl = localStorage.getItem("touchcontrol") == "true";

let gpsError = null;

const touchControl = () => {
	return forceTouchControl || !!gpsError;
};

const map = new maplibregl.Map({
	container: "map",
	center: target,
	minZoom: 15,
	maxZoom: 20,
	zoom: 18,
	pitch: 45,
	minPitch: 1,
	antialias: true,
	dragPan: false,
	scrollZoom: { around: "center" },
	touchZoomRotate: { around: "center" },
	doubleClickZoom: false,
	attributionControl: false,
	bearing: 180,
	keyboard: false,
	// key leakage is part of maptiler's ecosystem *shrug*
	// their "fix" is to allow restricting keys to certain 'Origin' headers ("pinky promise uwu")
	// honestly api keys are cringe anyway
	style:
		"https://api.maptiler.com/maps/" +
		(enable3d ? "streets-v2" : "bright") +
		"/style.json?key=DOnvuOySyPyQM83lAx0a",
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

const renderer = new THREE.WebGLRenderer({
	canvas: map.getCanvas(),
	context: map.painter.context.gl,
	antialias: true,
});
renderer.shadowMap.enabled = true;
renderer.autoClear = false;

const camera = new THREE.PerspectiveCamera();
const scene = new THREE.Scene();
const gltfLoader = new GLTFLoader();
const playerScale = 5;

const raycaster = new THREE.Raycaster();
const textures = new THREE.TextureLoader();

const openOverlay = (close) => {
	const overlay = document.body.appendChild(document.createElement("center"));
	overlay.style.position = "fixed";
	overlay.style.top = "0px";
	overlay.style.left = "0px";
	overlay.style.width = "100%";
	overlay.style.height = "100%";
	overlay.style.backgroundColor = "rgba(0, 0, 0, 0.3)";
	overlay.style.zIndex = "1";
	if (close)
		overlay.addEventListener("click", (evt) => {
			if (evt.target != overlay) return;
			if (close instanceof Function) close();
			document.body.removeChild(overlay);
		});
	return overlay;
};

// https://codepen.io/prisoner849/pen/abKdYgZ
const setUV = (geometry) => {
	let pos = geometry.attributes.position;
	let b3 = new THREE.Box3().setFromBufferAttribute(pos);
	let size = new THREE.Vector3();
	b3.getSize(size);
	let uv = [];
	let v3 = new THREE.Vector2();
	for (let i = 0; i < pos.count; i++) {
		v3.fromBufferAttribute(pos, i);
		v3.sub(b3.min).divide(size);
		uv.push(v3.x, v3.y);
	}
	geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
};

new SVGLoader().load("marker-model.svg", (data) => {
	const markerObj = new THREE.Group();
	const material = new THREE.MeshBasicMaterial({
		color: new THREE.Color(),
		side: THREE.DoubleSide,
		depthWrite: true,
		transparent: false,
		stencilWrite: true,
		stencilWriteMask: 0x80,
		stencilRef: 0x80,
		stencilFunc: THREE.AlwaysStencilFunc,
		stencilFail: THREE.KeepStencilOp,
		stencilZFail: THREE.KeepStencilOp,
		stencilZPass: THREE.ReplaceStencilOp,
	});

	for (const [i, shape] of data.paths
		.flatMap(SVGLoader.createShapes)
		.entries()) {
		const geometry = new THREE.ShapeGeometry(shape);
		setUV(geometry);
		const mesh = new THREE.Mesh(geometry);
		mesh.scale.setScalar(1 / 1792);
		mesh.position.set(-0.5, (1536 - 118.237) / 1792, i * 0.001);
		mesh.rotateX(Math.PI);
		markerObj.add(mesh);
	}

	markerObj.scale.setScalar(50);

	for (const marker of markers) {
		marker.obj = markerObj.clone();
		marker.obj.marker = marker;

		const texture = textures.load("markers/" + marker.name + "/icon.png");
		texture.flipY = false;
		texture.colorSpace = THREE.SRGBColorSpace;

		const ch = marker.obj.children;

		ch[0].material = material.clone();
		ch[1].material = material;

		const mat = (ch[2].material = material.clone());
		mat.map = texture;
		mat.transparent = true;

		scene.add(marker.obj);
	}
});

const clamp = (min, max, x) => Math.min(max, Math.max(min, x));
const rlerp = (min, max, x) => clamp(0, 1, (x - min) / (max - min));

const mapToMerc = maplibregl.MercatorCoordinate.fromLngLat;

const mercToThree = ({ x, y, z }) =>
	new THREE.Vector3(x, z, y).divideScalar(
		mapToMerc(map.getCenter()).meterInMercatorCoordinateUnits(),
	);

const threeCenter = () => mercToThree(mapToMerc(map.getCenter()));

const mapToThree = (lngLat) =>
	mercToThree(mapToMerc(lngLat, lngLat.altitude)).sub(threeCenter());

let player;

for (const m of models) m.path = "models/" + m.name.toLowerCase() + "/";

const setPlayerModel = async (model) => {
	const gltf = await new Promise((res, rej) => {
		gltfLoader
			.setPath(model.path)
			.setResourcePath(model.path)
			.load("scene.gltf", res, null, rej);
	});

	if (player) scene.remove(player.scene);

	document.getElementById("model-image").src = model.path + "preview.png";

	localStorage.setItem("model", model.name);

	player = gltf;
	player.doStop = model.doStop;

	player.scene.traverse((child) => {
		if (
			model.removeChildren &&
			model.removeChildren.indexOf(child.name) != -1
		) {
			child.visible = false;
		} else if (child.isMesh) {
			(child.material.isMaterial ? [child.material] : child.material).forEach(
				(m) => {
					m.castShadow = true;
					m.stencilWrite = true;
					m.stencilWriteMask = 0x80;
					m.stencilRef = 0x80;
					m.stencilFunc = THREE.AlwaysStencilFunc;
					m.stencilFail = THREE.ReplaceStencilOp;
					m.stencilZFail = THREE.ReplaceStencilOp;
					m.stencilZPass = THREE.ReplaceStencilOp;
				},
			);

			child.castShadow = true;
		}
	});

	player.scene.scale.setScalar(model.scale * playerScale);

	player.mixer = new THREE.AnimationMixer(player.scene);
	player.walk = player.mixer.clipAction(
		player.animations[model.animationIndex || 0],
	);

	if (model.timeScale) player.walk.timeScale = model.timeScale;

	if (!player.doStop) player.walk.play();

	if (model.rotateY) {
		player.scene.rotateY(Math.PI);

		const grp = new THREE.Group();
		grp.add(player.scene);
		player.scene = grp;
	}

	scene.add(player.scene);
};

const openContainer = (close, center) => {
	const overlay = openOverlay(close);

	const container = overlay.appendChild(document.createElement("div"));
	container.classList.add("ui-container");
	container.style.position = "absolute";
	container.style.width = "90%";
	container.style.left = "5%";

	if (center) {
		container.style.top = "50%";
		container.style.transform = "translateY(-50%)";
	}

	return [overlay, container];
};

const divOverlay = () => {
	const overlay = document.createElement("div");
	overlay.style.position = "absolute";
	overlay.style.top = "0px";
	overlay.style.left = "0px";
	overlay.style.width = "100%";
	overlay.style.height = "100%";
	overlay.style.backgroundColor = "rgba(0, 0, 0, 0.5)";
	return overlay;
};

const modelSelectionUI = (canClose) => {
	const [overlay, container] = openContainer(canClose, true);

	const perRow = innerWidth > innerHeight ? 3 : 2;

	const h1 = container.appendChild(document.createElement("h1"));
	h1.innerText = "Wähle dein Aussehen";

	const table = container.appendChild(document.createElement("table"));
	table.style.padding = "1em";
	table.style.paddingTop = "";
	table.style.width = "calc(100%-2em)";

	let clicked = false;
	let tr;
	for (const [i, model] of models.entries()) {
		if (i % perRow == 0) {
			tr = table.appendChild(document.createElement("tr"));
		}

		const td = tr.appendChild(document.createElement("td"));

		td.style.position = "relative";
		td.style.textAlign = "center";
		td.style.backgroundColor = "#d9e9c6";
		td.style.borderRadius = "10px";
		td.style.cursor = "pointer";

		td.addEventListener("click", () => {
			if (clicked) return;
			clicked = true;

			const loadOverlay = td.appendChild(divOverlay());
			loadOverlay.style.borderRadius = "10px";
			loadOverlay.style.textAlign = "center";
			loadOverlay.style.display = "table";

			const loadText = loadOverlay.appendChild(document.createElement("div"));
			loadText.innerText = "Lädt...";
			loadText.style.fontSize = "1.5em";
			loadText.style.color = "white";
			loadText.style.display = "table-cell";
			loadText.style.verticalAlign = "middle";

			setPlayerModel(model).then(() => {
				overlay.remove();
			});
		});

		td.appendChild(document.createElement("p"));

		const img = td.appendChild(document.createElement("img"));
		img.src = model.path + "preview.png";
		img.style.width = "100%";
		img.style.maxWidth = 100 / perRow + "%";
		img.style.maxHeight = 70 / Math.ceil(models.length / perRow) + "vh";

		td.appendChild(document.createElement("p")).innerText = model.name;
	}
};

{
	const button = document.getElementById("action-model");
	button.addEventListener("click", () => {
		modelSelectionUI(true);
	});

	const modelName = localStorage.getItem("model");
	const model = modelName && models.find((m) => m.name == modelName);

	if (model) setPlayerModel(model);
	else modelSelectionUI();
}

const scrollContainer = (headline, htmlContent) => {
	const [overlay, container] = openContainer(true, true);
	container.style.height = "90%";

	const close = container.appendChild(document.createElement("button"));
	close.style.position = "absolute";
	close.style.bottom = "5px";
	close.style.left = "5px";
	close.style.width = "calc(100% - 10px)";
	close.classList.add("ui-button");
	close.classList.add("button-overlay");
	close.innerText = "Schließen";
	close.addEventListener("click", () => {
		overlay.remove();
	});

	const scroll = container.appendChild(document.createElement("div"));
	scroll.style.overflowY = "scroll";
	scroll.style.maxHeight = "calc(100% - 10px - 2em)";

	const fade = scroll.appendChild(document.createElement("div"));
	fade.classList.add("fading-edge");

	const h1 = fade.appendChild(document.createElement("h1"));
	h1.innerText = headline;

	const content = fade.appendChild(document.createElement("div"));
	content.style.width = "90%";
	content.style.textAlign = "left";
	content.style.marginBottom = "calc(4em + 2em + 5px)";
	content.style.position = "relative";
	content.innerHTML = htmlContent;

	return [overlay, close];
};

document.getElementById("action-settings").addEventListener("click", () => {
	const [overlay, buttonClose] = scrollContainer(
		"Einstellungen",
		`
		<h2>Fortschritt zurücksetzen</h2>
		<p>Wenn du das Spiel von vorne beginnen möchtest, kannst du hier den Fortschritt zurücksetzen. Alle Marker sind danach wieder als unbekannt markiert.</p>
		<button id="reset-progress" style="padding: 0 1em 0 1em" class="ui-button button-overlay">Fortschritt zurücksetzen</button>

		<h2>Spiel neu laden</h2>
		<p>Wenn das Spiel ein Problem oder Fehler hat, kann es unter Umständen helfen, es neu zu laden. Dazu kannst du die Seite neu laden oder diesen Knopf verwenden. Dein Fortschritt bleibt dabei erhalten.</p>
		<button id="reload-game" style="padding: 0 1em 0 1em" class="ui-button button-overlay">Spiel neu laden</button>

		<h2>3D-Modus</h2>
		<p>Im 3D-Modus werden Gebäude dreidimensional auf der Karte angezeigt. Auf leistungsschwachen Geräten kann das zu Leistungsproblemen führen. Nach Änderung dieser Einstellung wird das Spiel neu geladen.</p>

		<input type="checkbox" id="checkbox-enable3d">
		<label for="checkbox-enable3d">3D-Modus einschalten</label>

		<h2>Steuerung</h2>
		<p>Das Spiel kann entweder durch deinen Standort oder durch Berühren der Karte gesteuert werden. Falls dein Gerät keine Standortinformationen unterstützt, wird die Berührsteuerung automatisch eingeschaltet.</p>
		<input type="checkbox" id="checkbox-touchcontrol">
		<label for="checkbox-touchcontrol">Berührsteuerung verwenden</label>
		`,
	);

	const boxEnable3d = document.getElementById("checkbox-enable3d");
	const boxTouchControl = document.getElementById("checkbox-touchcontrol");

	boxEnable3d.checked = enable3d;
	boxTouchControl.checked = touchControl();
	boxTouchControl.disabled = !!gpsError;

	const updateCloseButton = () => {
		if (boxEnable3d.checked != enable3d)
			buttonClose.innerText = "Speichern und neu laden";
		else if (boxTouchControl.checked != touchControl())
			buttonClose.innerText = "Speichern und schließen";
		else buttonClose.innerText = "Schließen";
	};

	boxEnable3d.addEventListener("input", updateCloseButton);
	boxTouchControl.addEventListener("input", updateCloseButton);

	buttonClose.addEventListener("click", () => {
		localStorage.setItem("enable3d", boxEnable3d.checked.toString());
		if (!gpsError)
			localStorage.setItem(
				"touchcontrol",
				(forceTouchControl = boxTouchControl.checked).toString(),
			);

		if (boxEnable3d.checked != enable3d) location.reload();
	});

	document.getElementById("reset-progress").addEventListener("click", () => {
		if (confirm("Möchtest du deinen Fortschritt zurücksetzen?")) {
			localStorage.setItem("completed", JSON.stringify((completed = {})));
			alert("Fortschritt zurückgesetzt.");
			overlay.remove();
		}
	});

	document.getElementById("reload-game").addEventListener("click", () => {
		location.reload();
	});
});

import licenseFile from "./LICENSE?url";

document.getElementById("action-info").addEventListener("click", () => {
	const modelLicenses = models
		.map(
			({ name, path }) => `<li><a href="${path}license.txt">${name}</a></li>`,
		)
		.join("");

	scrollContainer(
		"Informationen zum Spiel",
		`
		<h2> Über das Spiel </h2>
		<p> Du kannst bei diesem Spiel Figuren der Stadtgeschichte Aschaffenburgs entdecken, ihnen zuhören und sie dann in eine Zeitleiste einordnen. </p>
		<p> Wähle eine Spielerfigur und zoome mit zwei Fingern den Stadtplan und suche nach den hellblauen Icons. Dann kannst du zu einem Icon hinlaufen und es anklicken. </p>
		<p> Alternativ kannst du auch unter "Einstellungen" die Berührfunktion wählen. In diesem Fall musst du nur auf die Stelle im Stadtplan klicken, wo die Figur hinlaufen soll.
		<p> Wenn du das Icon angeklickt hast, erscheint ein Bild der Figur und trägt dir etwas über sich und das Gebäude, vor dem du stehst vor. Pass gut auf, und merke dir die Jahreszahl. Wenn die Figur fertig gesprochen hat, erscheint eine Zeitleiste. Du kannst in der Zeitleiste nach oben und unten scrollen. Ordne deine Figur dem passenden Feld zu. </p>
		<p>
			Wenn du unsicher bist, kannst du dir den Text noch einmal anhören. <br>
			Wenn du falsch antwortest, kannst du es noch einmal probieren. <br>
			Wenn du richtig geantwortet hast, bekommst du ein tolles Feuerwerk zur Belohnung. <br>
		</p>
		<p> Über "Schließen" kannst du die Zeitleiste wieder schließen und weiter spielen. </p>
		<p> Ziel des Spiel ist es alle 10 Figuren einzuordnen. </p>
		<h2> Entwicklung </h2>
		<p><b>Idee und Leitung:</b> Ruth Pabst</p>
		<p><b>Inhalte:</b> Schülerinnen und Schüler der Klasse 4a der Christian-Schad-Schule:
			Alexia, Andreo, Inga, Leonard, Lukas, Mara, Noah, Polina, Raphael und andere
		</p>
		<p><b>Programmierung und Design:</b> Charlotte Pabst (Pseudonym: "Lizzy Fleckenstein")</p>
		<p>
			Der Quelltext des Programms steht auf
			<a href="https://github.com/LizzyFleckenstein03/aschaffenburg.fun">
				GitHub</a>
			zur Verfügung.</p>
		<h2> Lizenzinformationen </h2>
		<h3> Quellcodelizenz: <a href="${licenseFile}">GPLv3</a></h3>
		<pre style="white-space: pre-wrap;">
Dieses Programm ist Freie Software: Sie können es unter den Bedingungen
der GNU General Public License, wie von der Free Software Foundation,
Version 3 der Lizenz oder (nach Ihrer Wahl) jeder neueren
veröffentlichten Version, weiter verteilen und/oder modifizieren.

Dieses Programm wird in der Hoffnung, dass es nützlich sein wird, jedoch
OHNE JEDE GEWÄHRLEISTUNG, bereitgestellt; sogar ohne die implizite
Gewährleistung der MARKTFÄHIGKEIT oder EIGNUNG FÜR EINEN BESTIMMTEN ZWECK.
Siehe die GNU General Public License für weitere Einzelheiten.

Sie sollten eine Kopie der GNU General Public License zusammen mit diesem
Programm erhalten haben. Wenn nicht, siehe <a href="https://www.gnu.org/licenses/">https://www.gnu.org/licenses/</a>
		</pre>

		<h3> Lizenzen der 3D-Modelle </h3>
		<ul>
		${modelLicenses}
		</ul>

		<h3> Medienlizenz </h3>
		<p>Alle Inhalte in den 'markers', 'yay' und 'fireworks' Ordnern wurden von Schülerinnen und Schülern bzw. Ruth Pabst erstellt und werden unter CC BY-SA 4.0 zur Verfügung gestellt. </p>

		<h3> Quellen verwendeter Medien</h3>
		<ul>
			<li><a href="https://commons.wikimedia.org/wiki/File:Cog_font_awesome.svg">gear.svg</a></li>
			<li><a href="https://commons.wikimedia.org/wiki/File:Font_Awesome_5_solid_info-circle.svg">info.svg</a></li>
			<li><a href="https://en.wikipedia.org/wiki/No_symbol#/media/File:ProhibitionSign2.svg">nope.svg</a></li>
			<li><a href="https://commons.wikimedia.org/wiki/File:Font_Awesome_5_regular_question-circle.svg">unknown.svg</a></li>
			<li><a href="https://de.m.wikipedia.org/wiki/Datei:Map_marker_font_awesome.svg">marker.svg</a></li>
			<li><a href="https://de.m.wikipedia.org/wiki/Datei:Map_marker_font_awesome.svg">marker-model.svg</a> (modifiziert)</li>
			<li><a href="https://de.wikipedia.org/wiki/Aschaffenburg#/media/Datei:Wappen_Aschaffenburg.svg">favicon.ico</a> (zu PNG konvertiert)</li>
			<li><a href="https://www.myinstants.com/en/instant/wrong-answer-buzzer-6983/">nope.mp3</a></li>
		</ul>

		<h3> Karten-Dienst </h3>
		<a href="https://www.maptiler.com/copyright/">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>

		<br><br>
		`,
	);
});

// shadow plane
{
	const geometry = new THREE.PlaneGeometry(60 * playerScale, 60 * playerScale);
	geometry.lookAt(new THREE.Vector3(0, 1, 0));

	const material = new THREE.ShadowMaterial();
	material.opacity = 0.3;
	material.alphaTest = 0.1;

	const plane = new THREE.Mesh(geometry, material);
	plane.receiveShadow = true;
	scene.add(plane);
}

// animated circle around player
{
	const geometry = new THREE.CircleGeometry(5 * playerScale, 64);
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

		const frustumSize = 15 * playerScale;
		this.shadow.camera = new THREE.OrthographicCamera(
			-frustumSize / 2,
			frustumSize / 2,
			frustumSize / 2,
			-frustumSize / 2,
			1 * playerScale,
			50 * playerScale,
		);

		this.positionFunc = positionFunc;
		this.update();

		// scene.add(new THREE.CameraHelper(this.shadow.camera));
		scene.add(this);

		this.time = 0;
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
		// const date = new Date(new Date().getTime() + this.time * 1000 * 60 * 10);
		const date = new Date();

		const pos = map.getCenter();
		const p = this.positionFunc(date, pos.lat, pos.lng);

		p.altitude = (p.altitude + Math.PI * 2) % (Math.PI * 2);
		this.visible =
			p.altitude > Math.PI * 0.05 && p.altitude < Math.PI * (1 - 0.05);

		const old = this.position.clone();
		this.position
			.set(1, 0, 0)
			.applyEuler(new THREE.Euler(0, p.azimuth, p.altitude))
			.multiplyScalar(5 * playerScale);

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

const info = document.body.appendChild(document.createElement("span"));
info.style.position = "absolute";
info.style.zIndex = 5;
info.style.color = "green";

const render = (gl, mercViewProj) => {
	const cam = mapToThree(map.getCameraPosition());

	const p = mapToMerc(map.getCenter());
	const s = p.meterInMercatorCoordinateUnits();

	camera.projectionMatrix = new THREE.Matrix4()
		.fromArray(mercViewProj)
		.multiply(
			new THREE.Matrix4()
				.makeTranslation(p.x, p.y, p.z)
				.scale(new THREE.Vector3(s, -s, s)),
		)
		.multiply(
			new THREE.Matrix4().makeRotationAxis(
				new THREE.Vector3(1, 0, 0),
				Math.PI / 2,
			),
		);

	cam.y = 0;

	for (const marker of markers) {
		if (!marker.obj) continue;

		marker.obj.position.copy(mapToThree(marker.pos));
		marker.obj.lookAt(cam);

		const close = rlerp(40, 60, marker.obj.position.length());

		marker.obj.children[0].material.color = new THREE.Color().fromArray(
			new Color("darkblue").mix(new Color("#2c88ff"), close, {
				space: "hwb",
				outputSpace: "srgb",
			}).srgb,
		);
		marker.reachable = close < 0.5;
	}

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
		map.getStyle().layers.find(
			(layer) =>
				layer.type in
				{
					"fill-extrusion": true,
					symbol: true,
				},
		)?.id,
	);
});

addEventListener("resize", () => {
	renderer.setSize(innerWidth, innerHeight);
});

let playerAnimDuration = 0;
{
	const clock = new THREE.Clock();
	let fadeOut = 0;

	const animate = () => {
		requestAnimationFrame(animate);
		const dt = clock.getDelta();

		player?.mixer.update(dt);

		if (playerAnimDuration <= 0) {
			if (player) {
				player.walk.paused = true;
				if (player.doStop) player.walk.stop();
			}
			return;
		}

		player?.walk.play();

		const lerp = (a, b, x) => a * (1 - x) + b * x;
		const x = Math.min(dt / playerAnimDuration, 1);

		const center = map.getCenter();
		center.lng = lerp(center.lng, target.lng, x);
		center.lat = lerp(center.lat, target.lat, x);

		playerAnimDuration -= dt;
		map.setCenter(center);
	};

	animate();
}

const clock = new THREE.Clock();
clock.getDelta();

const setTarget = (pos) => {
	console.log(pos);
	const dt = clock.getDelta();

	if (player) {
		player.scene.lookAt(mapToThree(pos));
		player.walk.play();
		player.walk.paused = false;
	}

	playerAnimDuration = Math.min(dt, 1.5);
	localStorage.setItem("position", JSON.stringify((target = pos)));
};

const buttonRow = (parent) => {
	const buttons = parent.appendChild(document.createElement("div"));
	buttons.style.display = "flex";
	buttons.style.flexDirection = "row";
	buttons.style.justifyContent = "center";
	buttons.style.gap = "5px";

	const addButton = (text, cb) => {
		const button = buttons.appendChild(document.createElement("button"));
		button.innerText = text;
		button.style.flex = "1";
		button.classList.add("ui-button");
		button.classList.add("button-overlay");
		button.addEventListener("click", cb);
		return button;
	};

	return [buttons, addButton];
};

const timelineSkeleton = (title, close) => {
	const [overlay, container] = openContainer(close);
	container.style.width = "calc(100% - 30px)";
	container.style.height = "calc(100% - 30px)";
	container.style.top = "9px";
	container.style.left = "9px";
	container.style.display = "flex";
	container.style.flexFlow = "column";

	const header = container.appendChild(document.createElement("div"));

	const headline = header.appendChild(document.createElement("h1"));
	headline.innerHTML = title;
	headline.style.flex = "0 1 auto";
	headline.style.width = "90%";

	const [buttons, addButton] = buttonRow(header);
	buttons.style.marginBottom = "0.5em";
	buttons.style.width = "90%";

	addButton("Schließen", () => {
		close?.();
		overlay.remove();
	});

	const body = container.appendChild(document.createElement("div"));
	body.style.flex = "1";

	return { overlay, container, header, headline, addButton, body };
};

const markerImage = (name) => {
	const img = document.createElement("img");
	img.alt = "Lädt...";
	img.src = "markers/" + name + "/image.png";
	img.style.height = "0";
	img.style.minHeight = "90%";
	img.style.width = "0";
	img.style.minWidth = "90%";
	img.style.objectFit = "scale-down";
	img.style.fontSize = "1.5em";
	return img;
};

const timeline = ({ marker, updateHelp, body }) => {
	const outer = body.appendChild(document.createElement("div"));
	outer.style.height = "calc(100% - 1em)";
	outer.style.width = "90%";
	outer.style.position = "relative";
	outer.style.backgroundColor = "#d9e9c6";
	outer.style.borderRadius = "10px";
	outer.style.boxShadow = "0 0 0 4px inset #7fb82e";

	const inner = outer.appendChild(document.createElement("div"));
	inner.style.position = "absolute";
	inner.style.top = "40px";
	inner.style.left = "4px";
	inner.style.height = "calc(100% - 80px)";
	inner.style.width = "calc(100% - 12px)";
	inner.style.overflowY = "scroll";
	inner.style.direction = "rtl";

	const pxPerYear = 5;
	const startYear = 900;

	for (let i = startYear; i <= 1900; i += 5) {
		const timestamp = inner.appendChild(document.createElement("span"));
		timestamp.style.position = "absolute";
		timestamp.style.top = (i - startYear) * pxPerYear + "px";
		timestamp.style.left = "0.5em";
		timestamp.style.width = "2.5em";
		timestamp.style.direction = "ltr";

		const showNum = i % 25 == 0;
		timestamp.innerText = showNum ? i : "-";
		timestamp.style.textAlign = "right";
	}

	for (const [dir, title, mult] of [
		["top", "Früher", -1],
		["bottom", "Später", 1], // 🥺
	]) {
		const button = outer.appendChild(document.createElement("button"));
		button.innerText = title;
		button.style[dir] = "0px";
		button.style.position = "absolute";
		button.style.left = "0px";
		button.style.width = "100%";
		button.style.height = "40px";
		button.classList.add("ui-button");

		button.style["border-" + dir + "-left-radius"] = "7px";
		button.style["border-" + dir + "-right-radius"] = "7px";

		button.addEventListener("click", () => {
			inner.scrollBy({
				top: 300 * mult,
				behavior: "smooth",
			});
		});
	}

	let assigned = false;
	const size = 32;

	for (const [i, { year, name, title }] of markers.entries()) {
		const want = year - size / 2;

		const topCompromise =
			(markers[i - 1] && (year + markers[i - 1].year) / 2 + 1) || want;
		const bottomCompromise =
			(markers[i + 1] && (year + markers[i + 1].year) / 2 - size - 1) || want;

		let offset;
		if (topCompromise > want) offset = topCompromise;
		else if (bottomCompromise < want) offset = bottomCompromise;
		else offset = want;

		const color = "hsla(" + (i / markers.length) * 360 + ",100%,50%,0.5)";

		const rect = inner.appendChild(document.createElement("div"));
		rect.style.position = "absolute";
		rect.style.width = size * pxPerYear + "px";
		rect.style.height = size * pxPerYear + "px";
		rect.style.top = "calc(" + (offset - startYear) * pxPerYear + "px + 1ex)";
		rect.style.left = "calc(3em + 20px)";
		rect.style.backgroundColor = color;
		rect.style.direction = "ltr";

		rect.style.display = "flex";
		rect.style.flexFlow = "column";

		const populateMarker = () => {
			const remainRect = rect.appendChild(document.createElement("div"));
			remainRect.style.flex = "1";

			const img = remainRect.appendChild(markerImage(name));
			img.style.minHeight = "calc(100% - 3px)";
			img.style.minWidth = "calc(100% - 3px)";
			img.style.position = "relative";
			img.style.top = "3px";

			const p = rect.appendChild(document.createElement("small"));
			p.innerText = title;
			p.style.padding = "3px";
			p.style.flex = "0 1 auto";
		};

		const makeArrow = (color) => {
			const arrow = rect.appendChild(document.createElement("div"));
			arrow.style.position = "absolute";
			arrow.style.width = "0";
			arrow.style.height = "0";
			arrow.style.borderTop = "20px solid transparent";
			arrow.style.borderBottom = "20px solid transparent";
			arrow.style.borderRight = "20px solid " + color;
			arrow.style.left = "-20px";
			arrow.style.top = "calc(" + (year - offset) * pxPerYear + "px - 20px)";
			return arrow;
		};

		makeArrow(color);

		if (completed[name]) {
			populateMarker();

			if (name == marker?.name) {
				rect.scrollIntoView({
					block: "center",
				});
				rect.style.animation = "blink 0.6s 3";
			}
		} else {
			const img = rect.appendChild(document.createElement("img"));
			img.src = "unknown.svg";
			img.style.position = "absolute";
			img.style.width = "80%";
			img.style.height = "80%";
			img.style.top = "10%";
			img.style.left = "10%";

			if (marker && !completed[marker.name]) {
				img.addEventListener("click", () => {
					if (assigned) return;

					if (name == marker.name) {
						img.remove();
						populateMarker();

						completed[marker.name] = true;
						localStorage.setItem("completed", JSON.stringify(completed));
						updateHelp?.();

						const fireworkOverlay = openOverlay(false);
						fireworkOverlay.style.color = "white";
						fireworkOverlay.style.fontSize = "3em";
						fireworkOverlay.style.backgroundColor = "rgba(0, 0, 0, 0.8)";

						const fireworkImg = fireworkOverlay.appendChild(
							document.createElement("img"),
						);
						fireworkImg.src =
							"fireworks/firework_" +
							Math.floor(Math.random() * fireworks) +
							".jpeg";
						fireworkImg.alt = "Lädt...";
						fireworkImg.style.maxWidth = "90%";
						fireworkImg.style.maxHeight = "90%";
						fireworkImg.style.top = "50%";
						fireworkImg.style.left = "50%";
						fireworkImg.style.position = "absolute";
						fireworkImg.style.transform = "translate(-50%, -50%)";
						fireworkImg.style.borderStyle = "solid";

						const fireworkSound = new Audio(
							"yay/yay_" + Math.floor(Math.random() * yays) + ".mp3",
						);

						fireworkImg.addEventListener("load", () => {
							const correct = fireworkOverlay.appendChild(
								document.createElement("span"),
							);
							correct.innerText = "RICHTIG";
							correct.style.position = "absolute";
							correct.style.transform = "translateX(-50%)";
							correct.style.letterSpacing = "0.5em";
							correct.style.fontWeight = "bold";
							correct.style.textIndent = "0.5em";
							correct.style.top = "10%";
							correct.style.textShadow = "4px 4px 0px #000000";

							fireworkSound.addEventListener("ended", () => {
								assigned = true;
								fireworkOverlay.remove();
								rect.style.animation = "blink 0.6s 3";
							});
							fireworkSound.play();
						});
					} else {
						const rectOverlay = rect.appendChild(divOverlay());
						const arrowOverlay = makeArrow("rgba(0, 0, 0, 0.5)");

						const nope = rectOverlay.appendChild(document.createElement("img"));
						nope.src = "nope.svg";
						nope.position = "absolute";
						nope.style.position = "absolute";
						nope.style.width = "78%";
						nope.style.height = "78%";
						nope.style.top = "11%";
						nope.style.left = "11%";

						const nopeSound = new Audio("nope.mp3");
						nopeSound.addEventListener("ended", () => {
							rectOverlay.remove();
							arrowOverlay.remove();
						});
						nopeSound.play();
					}
				});
			}
		}
	}
};

const triggerMarker = (marker) => {
	let finishAudio;

	const audio = new Audio("markers/" + marker.name + "/sound.mp3");
	audio.addEventListener("ended", () => {
		finishAudio();
	});
	audio.play();

	const { overlay, container, header, headline, addButton, body } =
		timelineSkeleton(marker.title, () => {
			audio.pause();
		});

	const skip = addButton("Überspringen", () => {
		audio.pause();
		finishAudio();
	});

	const img = body.appendChild(markerImage(marker.name));

	finishAudio = () => {
		img.remove();
		headline.remove();
		skip.remove();

		addButton("Nochmal anhören", () => {
			overlay.remove();
			triggerMarker(marker);
		});

		const help = header.insertBefore(
			document.createElement("p"),
			header.firstChild,
		);
		help.textAlign = "left";
		help.style.width = "90%";

		const updateHelp = () => {
			help.innerHTML = completed[marker.name]
				? `Du hast ${marker.title} auf der Zeitleiste eingeordnet.`
				: `<b>Ordne ${marker.title} auf der Zeitleiste ein!</b>`;
			// <br> Scrolle oder verwende die 'Früher'- und 'Später'-Knöpfe um den richtigen Ausschnitt in der Zeitleiste zu finden, dann tippe auf das passende Fragezeichen!
		};
		updateHelp();

		timeline({ marker, updateHelp, body });
	};
};

document.getElementById("action-timeline").addEventListener("click", () => {
	timeline({
		body: timelineSkeleton("Zeitleiste").body,
	});
});

const click = (evt) => {
	const mouse = new THREE.Vector2(
		(evt.point.x / map.transform.width) * 2 - 1,
		1 - (evt.point.y / map.transform.height) * 2,
	);

	const camInverseProjection = new THREE.Matrix4()
		.copy(camera.projectionMatrix)
		.invert();
	const cameraPosition = new THREE.Vector3().applyMatrix4(camInverseProjection);
	const mousePosition = new THREE.Vector3(mouse.x, mouse.y, 1).applyMatrix4(
		camInverseProjection,
	);
	const viewDirection = mousePosition.clone().sub(cameraPosition).normalize();

	raycaster.set(cameraPosition, viewDirection);

	for (const obj of raycaster.intersectObjects(
		markers.map((x) => x.obj),
		true,
	)) {
		const marker = obj.object.parent?.marker;
		if (marker?.reachable) {
			triggerMarker(marker);
			return;
		}
	}

	if (touchControl()) setTarget(evt.lngLat);
};

map.on("click", click);
map.on("touched", click);

const watchGeo = navigator.geolocation.watchPosition(
	({ coords: { longitude: lng, latitude: lat } }) => {
		if (!touchControl()) setTarget({ lng, lat });
		localStorage.removeItem("touchControlOpt");
	},
	(err) => {
		navigator.geolocation.clearWatch(watchGeo);
		gpsError = err;

		if (localStorage.getItem("touchControlOpt") == "true") return;

		const errBox = document.body.appendChild(document.createElement("div"));
		errBox.style.position = "fixed";
		errBox.style.top = "5px";
		errBox.style.left = "5px";
		errBox.style.width = "calc(100% - 10px - 8px)";
		errBox.classList.add("ui-container");
		errBox.style.zIndex = "0";

		const headCont = errBox.appendChild(document.createElement("div"));
		headCont.style.display = "flex";
		headCont.style.alignItems = "center";
		headCont.style.margin = "8px";

		const img = headCont.appendChild(document.createElement("img"));
		img.style.width = "4em";
		img.src = "info.svg";
		img.classList.add("colorize");

		const text = headCont.appendChild(document.createElement("div"));
		text.style.paddingLeft = "0.5em";

		const h1 = text.appendChild(document.createElement("h1"));
		h1.innerText = "Standortinformation nicht verfügbar";
		h1.style.padding = "0";
		h1.style.margin = "0";
		h1.style.fontSize = "1.1em";
		h1.style.paddingBotton = "0.2em";

		const p = text.appendChild(document.createElement("p"));
		p.style.padding = "";
		p.style.margin = "0";
		p.style.fontSize = "0.9em";
		p.innerText =
			"Stelle sicher, dass diese Seite die Erlaubnis hat, auf deinen Standort zuzugreifen oder verwende stattdessen die Berührsteuerung.";

		const [buttons, addButton] = buttonRow(errBox);
		buttons.style.margin = "8px";

		addButton("Erneut versuchen", () => {
			location.reload();
		});
		addButton("Berührsteuerung", () => {
			errBox.remove();
			localStorage.setItem("touchControlOpt", "true");
		});
	},
	{
		enableHighAccuracy: true,
	},
);

// ❤︎ anna
