import { FSWatcher, readFileSync, watch as watchFs, statSync, accessSync, readdirSync, PathLike, writeFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import { cfg as config, BaseConfig } from "./config";
import { LOGTAG } from "./lib/models/Config";
import * as WebSocket from "ws";


/**
 *
 *
 * @export
 * @class FakeAPIClient
 */
export class FakeAPIClient {
	protected static highlander: FakeAPIClient = null;

    /**
     *
     *
     * @static
     * @template TC
     * @param {string} [configRoot]
     * @returns {ConfigLoader<TC>}
     * @memberof FakeAPIClient
     */
	public static getInstance(): FakeAPIClient {
		if (!FakeAPIClient.highlander) {
			FakeAPIClient.highlander = new FakeAPIClient();
		}
		return FakeAPIClient.highlander;
	}

	private wsClient: WebSocket = null;
	private fsw: FSWatcher = null;
	private WatchMap: Map<string, NodeJS.Timer> = new Map<string, NodeJS.Timer>();
	private MapCache: Map<string, Buffer> = new Map<string, Buffer>();
	private wsReconnectTimer: NodeJS.Timer = null;

	private get cfg(): BaseConfig {
		return config;
	}

	private get mapPath(): PathLike {
		return resolve(this.cfg.map.rawroot, this.cfg.map.id);
	}

	private get mapId(): string {
		const idHash = createHash("sha256");
		idHash.update(this.cfg.map.id);
		return idHash.digest('hex');
	}

	private constructor() {
		this.initWSClient();
	}

	protected initWSClient() {
		!this.cfg.log.info ? null : console.log(LOGTAG.INFO, "[wsc:open]", `Connecting to RisinMap FakeAPI-Server on ${this.cfg.websocket.uplink}`);
		this.wsClient = new WebSocket(this.cfg.websocket.uplink);

		this.wsClient.on('open', () => {
			this.wsClient.send(JSON.stringify({ type: "auth", hash: this.mapId }));
		});

		this.wsClient.on('error', () => {
			if (!this.wsReconnectTimer) {
				this.wsReconnectTimer = setTimeout(() => {
					this.initWSClient();
				}, 5000);
			}
			this.wsReconnectTimer.refresh();
		});

		this.wsClient.on('close', () => {
			!this.cfg.log.info ? null : console.log(LOGTAG.INFO, "[wsc:close]", `Connection to RisinMap FakeAPI-Server closed, reconnect in 5 seconds`);
			if (!this.wsReconnectTimer) {
				this.wsReconnectTimer = setTimeout(() => {
					this.initWSClient();
				}, 5000);
			}
			this.wsReconnectTimer.refresh();
		});

		this.wsClient.on('message', (data: WebSocket.Data) => {
			if (typeof data == "string") {
				const msg = JSON.parse(data);
				switch (msg.type) {
					case "auth":
						if (msg.ok) {
							// Auth was ok
							this.initFSWatch();
							this.fullSync();
						} else {
							// Auth failed, wrong map?
							console.log(LOGTAG.ERROR, "[ws:auth]", `Your map id <${this.cfg.map.id}> could not be authenticated`);
							process.exit();
						}
						break;
					case "maptileresponse": // map tile response
						!this.cfg.log.debug ? null : console.log(LOGTAG.DEBUG, "[ws:maptileresponse]", `tile <${msg.hash}> response <${msg.ok}>`);
						const tileHash = msg.hash;
						if (msg.ok && this.MapCache.has(tileHash)) {
							// Server requests this map tile
							this.wsClient.send(this.MapCache.get(tileHash));
						} else {
							// Server does not want this tile
						}
						this.MapCache.delete(tileHash); // clear cache file
						break;
					default:
						break;
				}
			}
		})
	}

	protected sendTestSample() {
		const tileFileList = readdirSync(this.mapPath).filter(v => v.startsWith('mt'));
		!this.cfg.log.info ? null : console.log(LOGTAG.INFO, "[sendTestSample]", `Found ${tileFileList.length} map tiles`);
		if (tileFileList.length) {
			const f = tileFileList.shift();
			const [_, px, py] = f.split("_");
			const mapFilePath = resolve(this.cfg.map.rawroot, this.cfg.map.id, f);
			const mapFile = readFileSync(mapFilePath);
			const mapStats = statSync(mapFilePath);
			const mapHash = createHash("sha256");
			mapHash.update(mapFile);

			const mapTileInfo = {
				mapId: this.mapId,
				fileName: f,
				coords: {
					x: Number(px),
					y: Number(py)
				},
				hash: mapHash.digest('hex'),
				lastModifiedOn: mapStats.mtime
			};
			// save raw file in cache
			this.MapCache.set(mapTileInfo.hash, mapFile);
			// send map-tile-info to server
			this.wsClient.send(JSON.stringify({ type: 'map.tile.info', data: mapTileInfo }));
			// fire & forget cache cleaner
			setTimeout(() => {
				this.MapCache.delete(mapTileInfo.hash);
			}, 60000);
		}
	}

	protected fullSync() {
		const lockFilePath = resolve(__dirname, "..", "fullSync.lock");
		// 1. check if fullSync.lock file exists
		// 2. if not try to sync all map tiles
		// 3. create fullSync.lock after map is synced to prevent further full-syncs
		try {
			accessSync(lockFilePath);
			return; // File exists
		} catch (error) {
			// this is not a real error
			// console.log(LOGTAG.ERROR, "[fullSync]", error);
		}

		try {
			const tileFileList = readdirSync(this.mapPath).filter(v => v.startsWith('mt'));
			!this.cfg.log.info ? null : console.log(LOGTAG.INFO, "[fullSync]", `Found ${tileFileList.length} map tiles for full sync`);
			tileFileList.forEach(f => {
				const [_, px, py] = f.split("_");
				const mapFilePath = resolve(this.cfg.map.rawroot, this.cfg.map.id, f);
				const mapFile = readFileSync(mapFilePath);
				const mapStats = statSync(mapFilePath);
				const mapHash = createHash("sha256");
				mapHash.update(mapFile);

				const mapTileInfo = {
					mapId: this.mapId,
					fileName: f,
					coords: {
						x: Number(px),
						y: Number(py)
					},
					hash: mapHash.digest('hex'),
					lastModifiedOn: mapStats.mtime
				};
				// save raw file in cache
				this.MapCache.set(mapTileInfo.hash, mapFile);
				// send map-tile-info to server
				this.wsClient.send(JSON.stringify({ type: 'map.tile.info', data: mapTileInfo }));
				// fire & forget cache cleaner
				setTimeout(() => {
					this.MapCache.delete(mapTileInfo.hash);
				}, 60000);
			});
			writeFileSync(lockFilePath, "true");
		} catch (error) {
			console.log(LOGTAG.ERROR, "[fullSync]", error);
		}
	}

	protected initFSWatch() {
		!this.cfg.log.info ? null : console.log(LOGTAG.INFO, "[initFSWatch]", `Watching ${this.cfg.map.rawroot} with ${this.cfg.map.id}`);
		this.fsw = watchFs(this.mapPath, (event: string, f: string) => {
			// console.log(event, f);
			if (f.startsWith("mt")) {

				if (!this.WatchMap.has(f)) {
					const T = setTimeout(() => {
						const [_, px, py] = f.split("_");
						const mapFilePath = resolve(this.cfg.map.rawroot, this.cfg.map.id, f);
						const mapFile = readFileSync(mapFilePath);
						const mapStats = statSync(mapFilePath);
						const mapHash = createHash("sha256");
						mapHash.update(mapFile);

						
						const mapTileInfo = {
							mapId: this.mapId,
							fileName: f,
							coords: {
								x: Number(px),
								y: Number(py)
							},
							hash: mapHash.digest('hex'),
							lastModifiedOn: mapStats.mtime
						};
						!this.cfg.log.debug ? null : console.log(LOGTAG.DEBUG, "[fs:onMapChange]", `tile for ${px} ${py} changed ${mapTileInfo.hash}`);
						// save raw file in cache
						this.MapCache.set(mapTileInfo.hash, mapFile);
						// send map-tile-info to server
						this.wsClient.send(JSON.stringify({ type: 'map.tile.info', data: mapTileInfo }));
						// fire & forget cache cleaner
						setTimeout(() => {
							this.MapCache.delete(mapTileInfo.hash);
						}, 60000);
					}, 2000);
					this.WatchMap.set(f, T);
				}
				this.WatchMap.get(f).refresh();
			}
		});
	}

	public destroy() {
		this.wsClient.close();
		this.fsw.close();
	}
}