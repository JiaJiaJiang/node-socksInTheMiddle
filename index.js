const net = require('net'),
	zlib = require('zlib'),
	http = require('http'),
	https = require('https'),
	http2 = require('node:http2'),
	WebSocket = require('ws'),
	{ WebSocketServer } = require('ws'),
	{ Transform, Readable, pipeline } = require('stream');
const cloneDeep = require('lodash.clonedeep'),
	merge = require('lodash.merge'),
	pump = require('pump'),
	http2Wrapper = require('http2-wrapper'),
	{
		createSocksServer,
		TCPRelay,
		UDPRelay,
	} = require('socks5server/src/socks.js');
/**
 * for getting a full buffer from a stream and modifying it
 *
 * @class BufferModder
 * @extends {Transform}
 */
class BufferModder extends Transform {
	/**
	 * Creates an instance of BufferModder.
	 * @param {function(Buffer):Buffer|string} processer 
	 */
	constructor(processer) {
		super({
			objectMode: true,
			highWaterMark: 99999999999,
			allowHalfOpen: false,
		});
		this.processer = processer;
		this.buf = [];
	}
	_transform(chunk, encoding, cb) {
		this.buf.push(chunk);
		setImmediate(cb, null);
	}
	async _flush(cb) {
		let result = await this.processer(Buffer.concat(this.buf));
		if (typeof result === 'string') result = Buffer.from(result);
		this.push(result);
		this.buf.length = 0;
		this.buf = null;
		setImmediate(cb, null);
	}
}

/**
 * Modify properties here to change the request behaviour
 *
 * @class RequestOptions
 */
class RequestOptions {
	/** @type {string} http method */
	method;
	/** @type {string} connection scheme, "http"|"https"|"ws" etc. */
	scheme;
	/** @type {string} (optional)http host header, can contain port,  the hostname part will be set to "authority" in http2 */
	host;
	/** @type {number} (optional)the real port to connect to */
	port;
	/** @type {string} http path */
	path;
	/** @type {object} this is a cloned headers object from client request, you can modify it, but don't set pseudo-header headers here*/
	headers;
	/** @type {bool} auto use http2 protocol */
	autoHttp2 = true;
	/** @type {object} this is an extra config object that will be passed to http(s/2) request method */
	passingOptions = {};
	/** @readonly {http.IncomingMessage|http2.IncomingMessage} */
	reqFromClient;
	/** @readonly {http.OutgoingMessage|http2.OutgoingMessage} */
	resToClient;
	constructor(options) {
		assignExist(this, options);
	}
	// serverHttpVersion;
	/** @readonly client's http version */
	clientHttpVersion;
	/** @readonly get the target hostname to be connected to*/
	get hostname() {
		if (this.host) {
			const host = this.host.split(':');
			return host[0];
		} else {
			throw (new Error(`host is required`));
		}
	}
	/** @readonly get the target port to be connected to*/
	get hostport() {
		let port;
		if (this.port) {
			port = this.port;
		} else if (this.host) {
			const host = this.host.split(':');
			port = Number(host[1]);
		}
		if (!port) {
			switch (this.scheme) {
				case 'http': port = 80; break;
				case 'https': port = 443; break;
				default: throw (new Error(`cannot determine port`));
			}
		}
		return port;
	}
	toURL() {
		return `${this.scheme}://${this.hostname}:${this.hostport}/${this.path}`;
	}
}

class ResponseOptions {
	/** @readonly {RequestOptions} the RequestOptions for the related request */
	requestOptions;
	/** @type {number} http status */
	status;
	/** @type {object} this is a cloned headers object from server response, you can modify it, but don't set pseudo-header headers here*/
	headers;
	/** @readonly {http.IncomingMessage|http2.IncomingMessage} */
	reqFromClient;
	/** @readonly {http.OutgoingMessage|http2.OutgoingMessage} */
	resToClient;
	/** @readonly {*} */
	resFromServer;
	/** @readonly target server's http version */
	serverHttpVersion;
	constructor(options) {
		assignExist(this, options);
	}
}

/**
 * SocksInTheMiddle class
 *
 * @class SocksInTheMiddle
 */
class SocksInTheMiddle {
	socksServer;
	_httpReady = false;
	_httpsReady = false;
	socksLog = true;
	httpLog = true;
	requestModder;
	responseModder;
	websocketModder;
	tcpOutGoingModder;
	tcpInComingModder;
	udpModder;
	httpServer;
	httpsServer;
	webSocketServer = new WebSocketServer({
		clientTracking: false,
		noServer: true,
	});
	activeRelays = new Set();
	get httpPort() {
		return this.httpServer.address().port;
	}
	get httpsPort() {
		return this.httpsServer.address().port;
	}
	constructor(socksServerOptions = {}) {
		const {
			socksHost,
			socksPort,
			httpHost,
			httpPort,
			httpsHost,
			httpsPort,
			httpsOptions,
			socksLog,
			httpLog,
		} = socksServerOptions;
		this.socksLog = socksLog || false;
		this.httpLog = httpLog || false;
		this.socksServer = createSocksServer(socksServerOptions);
		this.websockets = new WeakMap();//req => socket
		if (Number.isInteger(socksPort)) {
			this.socksServer
				.on('tcp', this.relayTCP.bind(this))
				.on('udp', this.relayUDP.bind(this))
				.on('error', e => {
					console.error('SERVER ERROR: %j', e);
				}).on('client_error', (socket, e) => {
					this.socksLog && console.error('  [client error]', `${net.isIP(socket.targetAddress) ? '' : '(' + socket.targetAddress + ')'} ${socket.remoteAddress}:${socket.targetPort}`, e.message);
				}).on('socks_error', (socket, e) => {
					this.socksLog && console.error('  [socks error]', `${net.isIP(socket.targetAddress) ? '' : '(' + (socket.targetAddress || "unknown") + ')'} ${socket.remoteAddress || "unknown"}:${socket.targetPort || "unknown"}`, e);
				}).listen(socksPort || 1080, socksHost || '127.0.0.1', () => {
					this.socksLog && console.log(`socks server listening on : ${this.socksServer.address().address}:${this.socksServer.address().port}`);
				});
		}

		//create http server
		if (Number.isInteger(httpPort)) {
			this.httpServer = http.createServer((req, res) => this._dataModder(req, res, 'http'))
				.listen(httpPort, httpHost || '127.0.0.1', () => {
					this._httpReady = true;
					const { address, port } = this.httpServer.address();
					this.httpLog && console.log(`http server is listening on : ${address}:${port}`);
				});
			this.httpLog && console.log(`http server try listening on : ${httpHost || '127.0.0.1'}:${httpPort}`);
		}
		//create https server
		if (Number.isInteger(httpsPort)) {
			this.httpsServer = http2.createSecureServer(httpsOptions)
				.on('request', (req, res) => this._dataModder(req, res, 'https'))
				.listen(httpsPort, httpsHost || '127.0.0.1', () => {
					this._httpsReady = true;
					const { address, port } = this.httpServer.address();
					this.httpLog && console.log(`https server is listening on : ${address}:${port}`);
				});
			this.httpLog && console.log(`https server try listening on : ${httpsHost || '127.0.0.1'}:${httpsPort}`);
		}
	}
	/**
	 * set HTTP request modify functions
	 *
	 * @param {functoin} reqMod for modifying request
	 * @param {function} resMod for modifying response
	 */
	setHTTPModder(reqMod, resMod) {
		this.requestModder = reqMod;
		this.responseModder = resMod;
		return this;
	}
	/**
	 * set a WebSocket modify function
	 *
	 * @param {function(reqFromClient,source,data)} modder for modifying websocket messages
	 */
	setWebSocketModder(func) {
		this.websocketModder = func;
		return this;
	}
	/**
	 *set raw socks payload stream modder
	 *
	 * @param {Transform} outgoing
	 * @param {Transform} incoming
	 */
	setTCPModder(outgoing, incoming) {
		this.tcpOutGoingModder = outgoing;
		this.tcpInComingModder = incoming;
	}
	/**
	 * set a udp modify function
	 *
	 * @param {functoin} func
	 */
	setUDPModder(func) {
		this.udpModder = func;
		return this;
	}
	_dataModder(reqFromClient, resToClient, protocol) {
		reqFromClient.protocol = protocol;
		this._requestModder(reqFromClient, resToClient, (reqToServer, resFromServer, reqOptions) => {
			this._responseModder(resToClient, resFromServer, reqFromClient, reqToServer, reqOptions);
		}).catch(err => {
			this.httpLog && console.error(err);
		});
	}
	async _requestModder(reqFromClient, resToClient, cb) {
		let rawReqHeaders = reqFromClient.headers,
			streamChain = [reqFromClient];
		/* overrideRequestOptions = { protocol: reqFromClient.protocol } ;*/
		function badStatCheck(forceError) {
			if (reqFromClient.errored || reqFromClient.closed || resToClient.writableEnded || forceError) {
				for (let s of streamChain) if (!s.destroyed) s.destroy();
				resToClient.destroy();
				reqFromClient.destroy();
				throw (forceError || new Error('bad request stat, clear streams'));
			}
		}
		const reqHeaders = cloneDeep(reqFromClient.headers);
		const reqOptions = new RequestOptions({
			method: reqFromClient.method,
			scheme: reqFromClient.protocol ?? reqFromClient.scheme,
			host: reqHeaders[':authority'] ? reqHeaders[':authority'] : reqHeaders.host,
			path: reqFromClient.url,
			headers: reqHeaders,
		});
		for (let n in reqHeaders) {
			if (n.startsWith(':')) delete reqHeaders[n];
		}
		defineReadOnly(reqOptions, {
			clientHttpVersion: reqFromClient.httpVersionMajor,
			reqFromClient,
			resToClient,
		});
		defineReadOnly(reqFromClient, {
			isHTTP2: reqFromClient.httpVersionMajor === 2,
			isWebScoket: reqHeaders.upgrade === 'websocket',
		});

		const rawURL = reqOptions.toURL();
		if (this.requestModder) {
			try {
				let streamModder = await this.requestModder(reqOptions);
				if (!reqFromClient.isWebScoket && streamModder) {
					if (streamModder instanceof Transform) {//if the modder stream is an instance of Transform, the raw data will be piped in
						streamChain.push(streamModder);
					} else if (streamModder instanceof Readable) {//if the modder stream is just a readable stream, the stream will replace the raw data
						streamChain = [streamModder];
						reqFromClient.on('data', () => { });//consume source data
					}
				} else if (resToClient.writableEnded) {
					throw (new Error('resToClient.writableEnded'));
				} else if (streamModder === false) {
					throw (new Error('request canceled by modder'));
				}
			} catch (err) {
				badStatCheck(err);
			}
		}
		let relayReqOptions = {
			headers: reqOptions.headers,
			method: reqOptions.method,
			hostname: reqOptions.hostname,
			port: reqOptions.hostport,
			path: reqOptions.path,
		};
		merge(relayReqOptions, reqOptions.passingOptions);
		for (let h in relayReqOptions.headers) {
			if (h.startsWith(':')) {
				badStatCheck(new Error(`pseudo-header should not be set manualy`));
			}
		}

		const relayURL = reqOptions.toURL();
		defineReadOnly(reqFromClient, { relayURL });
		this.httpLog && console.log(`(relay out)[%s]`, rawURL, rawURL !== relayURL ? ` -> [${relayURL}]` : '');
		let reqToServer;
		if (reqFromClient.isWebScoket) {
			reqToServer = new WebSocket(relayURL.replace(/^http/, 'ws'), relayReqOptions);
			reqToServer.on('upgrade', (resFromServer) => {
				cb(reqToServer, resFromServer, reqOptions);
			}).on('error', err => {
				this.httpLog && console.error(`(relay websocket error) [${reqFromClient.relayURL}]`);
				this.httpLog && console.error(err);
			});
			return;
		} else {
			if (reqOptions.autoHttp2) {
				try {
					reqToServer = await http2Wrapper.auto(relayReqOptions, (resFromServer) => {
						cb(reqToServer, resFromServer, reqOptions);
					});
				} catch (err) {
					// this.httpLog && console.error('(relay request error)[%s]\n', relayURL, err);
					badStatCheck(err);
				}
			} else {
				let lib;
				switch (reqOptions.scheme) {
					case 'http': lib = http; break;
					case 'https': lib = https; break;
					default: badStatCheck(new Error('invalid scheme'));
				}
				reqToServer = lib.request(relayReqOptions, (resFromServer) => {
					cb(reqToServer, resFromServer, reqOptions);
				});
			}
		}
		streamChain.push(reqToServer);
		pump(...streamChain, (err) => {
			if (err && this.httpLog) {
				if (err.rawPacket) err.rawText = err.rawPacket.toString();
				this.httpLog && console.error(`(relay request error)[%s]`, rawURL, rawURL !== relayURL ? ` -> [${relayURL}]` : '');
				this.httpLog && console.error(err);
			}
		});
	}
	async _responseModder(resToClient, resFromServer, reqFromClient, reqToServer, reqOptions) {
		let streamChain = [resFromServer];
		function badStatCheck(forceError) {
			if (resToClient.errored || resToClient.closed || resToClient.destroyed || forceError) {
				for (let s of streamChain) if (!s.destroyed) s.destroy();
				reqToServer.destroy();
				reqFromClient.destroy();
				resToClient.destroy();
				resFromServer.destroy();
				throw (forceError || new Error('bad request stat, clear streams'));
			}
		}
		badStatCheck();
		const resHeaders = cloneDeep(resFromServer.headers);
		const resOptions = new ResponseOptions({
			status: resFromServer.statusCode,
			headers: resHeaders,
		});
		defineReadOnly(resOptions, {
			serverHttpVersion: resFromServer.httpVersionMajor,
			requestOptions: reqOptions,
			reqFromClient,
			resToClient,
			resFromServer,
		});
		defineReadOnly(resFromServer, {
			isHTTP2: resFromServer.httpVersionMajor === 2,
		});

		if (this.responseModder) {
			try {
				let streamModder = await this.responseModder(resOptions);
				if (!reqFromClient.isWebScoket && streamModder) {
					delete resHeaders['content-length'];//the content length may be changed
					if (!reqFromClient.isHTTP2) resHeaders['transfer-encoding'] = 'chunked';
					const enc = resHeaders['content-encoding'];
					if (streamModder instanceof Transform) {//if the modder stream is an instance of Transform, the raw data will be piped in
						if (enc) {
							const contentDecoder = contentDecoderSelector(enc);
							// const contentEncoder=contentEncoderSelector(enc);//encode the data is uselesss
							streamChain.push(contentDecoder, streamModder/* ,contentEncoder */);
							delete resHeaders['content-encoding'];
						} else {
							streamChain.push(streamModder);
						}
					} else if (streamModder instanceof Readable) {//if the modder stream is just a readable stream, the stream will replace the raw data
						streamChain = [streamModder];
						delete resHeaders['content-encoding'];
						/* if(enc){
							const contentEncoder=contentEncoderSelector(enc);
							streamChain.push(contentEncoder);
						} */
						//ignore server response
						resFromServer.destroy();
						// resFromServer.on('data', () => { });//consume source data
					}
				}
			} catch (err) {
				badStatCheck(err);
			}
		}
		if (reqFromClient.isHTTP2 || resFromServer.isHTTP2) {
			filterHttp2PseudoHeader(resHeaders);
		}
		for (let [name, value] of Object.entries(resOptions.headers)) {
			resToClient.setHeader(name, value);
		}
		if (reqFromClient.isWebScoket) {
			this.webSocketServer.handleUpgrade(reqFromClient, reqFromClient.socket, '', (ws) => {
				ws.once('open', () => {
				}).on('message', async (data, isBinary) => {
					data = isBinary ? data : data.toString();
					data = await (this.websocketModder?.(reqFromClient, 'client', data) || data);
					reqToServer.send(data);
				});
				reqToServer.on('message', async (data, isBinary) => {
					data = isBinary ? data : data.toString();
					data = await (this.websocketModder?.(reqFromClient, 'server', data) || data);
					ws.send(data);
				});
			});
		} else {
			resToClient.statusCode = resOptions.status;
			if (resToClient.statusCode >= 400) {
				console.log(reqToServer);
			}
			streamChain.push(resToClient);
			pump(...streamChain, (err) => {
				if (err && this.httpLog) {
					console.error(`(relay response error) [${reqFromClient.relayURL}]`);
					console.error(err);
				}
			});
		}
	}
	/**
	 *relay tcp connection to inner http server
	 *
	 * @param {net.Socket} socket
	 * @param {string} rawAddress
	 * @param {numhber} rawPort
	 * @param {function} CMD_REPLY
	 */
	relayTCP(socket, rawAddress, rawPort, CMD_REPLY) {
		let port;
		CMD_REPLY();//must reply the socks request first to get raw tcp stream
		this.socksLog && console.log(`[TCP Relay]${rawAddress}:${rawPort}`);
		socket.once('readable', () => {
			let chunk = socket.read(15);
			if (chunk) {//check connection protocol
				socket.unshift(chunk);//give back the chunk
				if (isHTTPHeader(chunk)) {
					if (!this._httpReady) {
						socket.destroy(new Error('http server not ready'));
						return;
					}
					port = this.httpPort;
				} else {
					if (!this._httpReady) {
						socket.destroy(new Error('https server not ready'));
						return;
					}
					port = this.httpsPort;
				}
			}

			if (!port) return;
			let relay = new TCPRelay(socket, '127.0.0.1', port, CMD_REPLY);
			this.activeRelays.add(relay);
			//set stream modder for tcp relay
			if (this.tcpOutGoingModder) relay.outModifier = new this.tcpOutGoingModder();
			if (this.tcpInComingModder) relay.outModifier = new this.tcpInComingModder();
			relay.once('connection', (socket, relaySocket) => {
				this.socksLog && console.log('[TCP]', `${socket.remoteAddress}:${socket.remotePort} ==> ${net.isIP(rawAddress) ? '' : '(' + rawAddress + ')'} ${relaySocket.remoteAddress}:${relaySocket.remotePort}`);
			}).on('proxy_error', (err, socket, relaySocket) => {
				this.socksLog && console.error('	[TCP proxy error]', `${relay.remoteAddress}:${relay.remotePort}`, err.message);
			}).once('close', e => {
				this.activeRelays.delete(relay);
				let msg = '';
				if (socket.remoteAddress)
					msg += `${socket.remoteAddress}:${socket.remotePort} ==> `;
				if (relay.remoteAddress) {
					msg += `${net.isIP(rawAddress) ? '' : '(' + rawAddress + ')'} ${relay.remoteAddress}:${relay.remotePort}`;
				} else {
					msg += `${rawAddress}:${port}`;
				}
				this.socksLog && console.log('  [TCP closed]', msg);
			});
		});
	}
	/**
	 * udp message modifier
	 * @private
	 * @param {boolean} fromClient is the message from client
	 * @param {object} packet	packet
	 * @param {string} packet.address	source address
	 * @param {number} packet.port	source port
	 * @param {Buffer} packet.data	udp message
	 */
	async _udpModder(fromClient, packet) {
		if (this.udpModder) {
			await this.udpModder(fromClient, packet);
		}
	}
	/**
	 *relay udp
	 *
	 * @param {net.Socket} socket
	 * @param {string} address
	 * @param {numhber} port
	 * @param {function} CMD_REPLY
	 */
	relayUDP(socket, address, port, CMD_REPLY) {
		this.socksLog && console.log(`[UDP Relay]${address}:${port}`);
		let relay = new UDPRelay(socket, address, port, CMD_REPLY);
		this.activeRelays.add(relay);
		relay.on('proxy_error', (relaySocket, direction, err) => {
			this.activeRelays.delete(relay)
			this.socksLog && console.error('	[UDP proxy error]', `[${direction}]`, err.message);
		});
		relay.relaySocket.once('close', () => {
			this.activeRelays.delete(relay)
			this.socksLog && console.log('  [UDP closed]', socket.remoteAddress);
		});

		relay.packetHandler = this._udpModder.bind(this);
	}
	close() {
		// clear all active relays
		this.activeRelays.forEach(relay => relay.close());
		this.activeRelays.clear();

		this.socksServer.close();
		this.httpServer && this.httpServer.close();
		this.httpsServer && this.httpsServer.close();
		this.webSocketServer && this.webSocketServer.close();
	}
}

function contentDecoderSelector(enc) {
	switch (enc) {
		case 'gzip': return zlib.createUnzip();
		case 'deflate': return zlib.createInflate();
		case 'br': return zlib.createBrotliDecompress();
		default: throw (new Error('unknown encoding:' + enc));
	}
}
function contentEncoderSelector(enc) {
	switch (enc) {
		case 'gzip': return zlib.createGzip();
		case 'deflate': return zlib.createDeflate();
		case 'br': return zlib.createBrotliCompress();
		default: throw (new Error('unknown encoding:' + enc));
	}
}

function isHTTPHeader(buf) {
	let str = buf.toString();
	if (str.startsWith('GET')
		|| str.startsWith('POST')
		|| str.startsWith('HEAD')
		|| str.startsWith('PUT')
		|| str.startsWith('DELETE')
		|| str.startsWith('CONNECT')
		|| str.startsWith('OPTIONS')
		|| str.startsWith('TRACE')
		|| str.startsWith('PATCH'))
		return true;
	return false;
}

function filterHttp2PseudoHeader(headers) {
	for (let name in headers) {
		if (name.startsWith(':')) {
			delete headers[name];
		}
	}
	delete headers['transfer-encoding'];//http2 dosen't support this header
	delete headers['host'];
}

function assignExist(obj, source, onlyDefined = true) {
	if (source === null || typeof source !== 'object') {
		throw (new Error('arguments should be objects, got a ' + typeof nextObj));
	}
	for (let k in obj) {
		if ((k in source) === false) continue;
		if (onlyDefined && source[k] === undefined) continue;
		obj[k] = source[k];
	}
	return obj;
}
function defineReadOnly(obj, props) {
	for (let name in props) {
		Object.defineProperty(obj, name, {
			value: props[name],
			writable: false,
			configurable: false,
		});
	}
}
module.exports = {
	SocksInTheMiddle,
	RequestOptions,
	ResponseOptions,
	BufferModder,
}