const net = require('net'),
	zlib = require('zlib'),
	http = require('http'),
	https = require('https'),
	http2 = require('node:http2'),
	WebSocket = require('ws'),
	{WebSocketServer}  = require('ws'),
	{Transform,Readable} = require('stream');
const {
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
class BufferModder extends Transform{
	/**
	 * Creates an instance of BufferModder.
	 * @param {function(Buffer):Buffer|string} processer 
	 */
	constructor(processer){
		super({
			highWaterMark:1638400,
			allowHalfOpen:false,
		});
		this.processer=processer;
		this.buf=[];
	}
	_transform(chunk, encoding, cb){
		this.buf.push(chunk);
		setImmediate(cb,null);
	}
	async _flush(cb){
		let result=await this.processer(Buffer.concat(this.buf));
		if(typeof result === 'string')result=Buffer.from(result);
		this.push(result);
		this.buf.length=0;
		this.buf=null;
		setImmediate(cb,null);
	}
}


/**
 * SocksInTheMiddle class
 *
 * @class SocksInTheMiddle
 */
class SocksInTheMiddle{
	socksServer;
	_httpReady=false;
	_httpsReady=false;
	socksLog=true;
	httpLog=true;
	requestModder;
	responseModder;
	websocketModder;
	tcpOutGoingModder;
	tcpInComingModder;
	udpModder;
	httpServer;
	httpsServer;
	webSocketServer=new WebSocketServer({
		clientTracking:false,
		noServer:true,
	});
	get httpPort(){
		return this.httpServer.address().port;
	}
	get httpsPort(){
		return this.httpsServer.address().port;
	}
	constructor(socksServerOptions={}){
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
		}=socksServerOptions;
		this.socksLog=socksLog||false;
		this.httpLog=httpLog||false;
		this.socksServer=createSocksServer(socksServerOptions);
		this.websockets=new WeakMap();//req => socket
		if(Number.isInteger(socksPort)){
			this.socksServer
			.on('tcp',this.relayTCP.bind(this))
			.on('udp',this.relayUDP.bind(this))
			.on('error', e=>{
				console.error('SERVER ERROR: %j', e);
			}).on('client_error',(socket,e)=>{
				this.socksLog&&console.error('  [client error]',`${net.isIP(socket.targetAddress)?'':'('+socket.targetAddress+')'} ${socket.remoteAddress}:${socket.targetPort}`,e.message);
			}).on('socks_error',(socket,e)=>{
				this.socksLog&&console.error('  [socks error]',`${net.isIP(socket.targetAddress)?'':'('+(socket.targetAddress||"unknown")+')'} ${socket.remoteAddress||"unknown"}:${socket.targetPort||"unknown"}`,e);
			}).listen(socksPort||1080, socksHost||'127.0.0.1',()=>{
				this.socksLog&&console.log(`socks server listening on : ${this.socksServer.address().address}:${this.socksServer.address().port}`);
			});
		}

		//create http server
		if(Number.isInteger(httpPort)){
			this.httpServer=http.createServer((req,res)=>this._dataModder(req,res,'http'))
			.listen(httpPort,httpHost||'127.0.0.1',()=>{
				this._httpReady=true;
				const {address,port}=this.httpServer.address();
				this.httpLog&&console.log(`http server is listening on : ${address}:${port}`);
			});
			this.httpLog&&console.log(`http server try listening on : ${httpHost||'127.0.0.1'}:${httpPort}`);
		}
		//create https server
		if(Number.isInteger(httpsPort)){
			this.httpsServer=http2.createSecureServer(httpsOptions)
			.on('request',(req, res)=>this._dataModder(req,res,'https'))
			.listen(httpsPort,httpsHost||'127.0.0.1',()=>{
				this._httpsReady=true;
				const {address,port}=this.httpServer.address();
				this.httpLog&&console.log(`https server is listening on : ${address}:${port}`);
			});
			this.httpLog&&console.log(`https server try listening on : ${httpsHost||'127.0.0.1'}:${httpsPort}`);
		}
	}
	/**
	 * set HTTP request modify functions
	 *
	 * @param {functoin} reqMod for modifying request
	 * @param {function} resMod for modifying response
	 */
	setHTTPModder(reqMod,resMod){
		this.requestModder=reqMod;
		this.responseModder=resMod;
		return this;
	}
	/**
	 * set a WebSocket modify function
	 *
	 * @param {function(reqFromClient,source,data)} modder for modifying websocket messages
	 */
	setWebSocketModder(func){
		this.websocketModder=func;
		return this;
	}
	/**
	 *set raw socks payload stream modder
	 *
	 * @param {Transform} outgoing
	 * @param {Transform} incoming
	 */
	setTCPModder(outgoing,incoming){
		this.tcpOutGoingModder=outgoing;
		this.tcpInComingModder=incoming;
	}
	/**
	 * set a udp modify function
	 *
	 * @param {functoin} func
	 */
	setUDPModder(func){
		this.udpModder=func;
		return this;
	}
	_dataModder(reqFromClient,resToClient,protocol){
		reqFromClient.protocol=protocol;
		this._requestModder(reqFromClient,resToClient,(reqToServer,resFromServer)=>{
			this._responseModder(resToClient,resFromServer,reqFromClient,reqToServer);
		});
	}
	async _requestModder(reqFromClient,resToClient,cb){
		let rawheaders=reqFromClient.headers,streamChain=[reqFromClient],
			overrideRequestOptions={protocol:reqFromClient.protocol};
		const headers={};
		for(let n in rawheaders){
			headers[n.replace(/^\:/,'')]=rawheaders[n];
		}
		if(headers.authority){
			reqFromClient.isHTTP2=true;
			headers.host=headers.authority;
			delete headers.authority;
		}
		if(headers.upgrade){
			reqFromClient.isWebScoket=true;
		}
		const rawHost=headers.host.split(':');
		const rawURL=`${reqFromClient.protocol}://${headers.host}:${rawHost[1]||(reqFromClient.protocol==='https'?443:80)}${reqFromClient.url}`;
		if(this.requestModder){
			let streamModder=await this.requestModder(headers,reqFromClient,resToClient,overrideRequestOptions);
			if(!reqFromClient.isWebScoket&&streamModder){
				if(streamModder instanceof Transform){//if the modder stream is an instance of Transform, the raw data will be piped in
					streamChain.push(streamModder);
				}else if(streamModder instanceof Readable){//if the modder stream is just a readable stream, the stream will replace the raw data
					streamChain=[streamModder];
					reqFromClient.on('data',()=>{});//consume source data
				}
			}else if(resToClient.writableEnded || streamModder===false){
				return;
			}
		}
		if(reqFromClient.errored || reqFromClient.closed){//dont create the relay if the source is errored or destroyed
			// for(let s of streamChain)if(!s.destroyed)s.destroy();
			return;
		}
		let host=headers.host.split(':');
		let protocol=overrideRequestOptions.protocol;
		let options=Object.assign({
			headers,
			method:reqFromClient.method,
			timeout:10000,
			rejectUnauthorized:true,
			hostname:host[0],
			port:host[1],
			path:reqFromClient.url,
		},overrideRequestOptions);
		options.protocol=protocol+':';
		if(!options.port){
			options.port=protocol==='https'?443:80;
		}
		const relayURL=`${protocol}://${options.hostname}:${options.port}${options.path}`;
		reqFromClient.relayURL=relayURL;
		this.httpLog&&console.log(`(relay out)[%s]`,rawURL,rawURL!==relayURL?` -> [${relayURL}]`:'');
		let reqToServer;
		if(reqFromClient.isWebScoket){
			reqToServer=new WebSocket(relayURL.replace(/^http/,'ws'),options);
			reqToServer.on('upgrade',(resFromServer)=>{
				cb(reqToServer,resFromServer);
			}).on('error',err=>{
				if(this.httpLog){
					console.error(`(relay websocket error) [${reqFromClient.relayURL}]`);
					console.error(err);
				}
			});
			return;
		}else{
			reqToServer=(protocol==='https'?https:http).request(options,(resFromServer)=>{
				cb(reqToServer,resFromServer);
			});
		}
		
		streamChain.push(reqToServer);
		chainPipe(streamChain,(err)=>{
			if(this.httpLog){
				if(err.rawPacket)err.rawText=err.rawPacket.toString();
				console.error(`(relay request error)[%s]`,rawURL,rawURL!==relayURL?` -> [${relayURL}]`:'');
				console.error(err);
			}
		});
	}
	async _responseModder(resToClient,resFromServer,reqFromClient,reqToServer){
		if(reqFromClient.errored  || reqFromClient.closed){//close the response if the source has broken
			if(!resFromServer.destroyed)resFromServer.destroy();
			return;
		}
		let rawheaders=Object.assign({},resFromServer.headers),streamChain=[resFromServer];
		const headers={};
		for(let n in rawheaders){
			headers[n]=rawheaders[n];
		}
		if(this.responseModder){
			let streamModder=await this.responseModder(headers,resFromServer,reqFromClient);
			if(!reqFromClient.isWebScoket&&streamModder){
				delete headers['content-length'];
				headers['transfer-encoding']='chunked';
				const enc=headers['content-encoding'];
				if(streamModder instanceof Transform){//if the modder stream is an instance of Transform, the raw data will be piped in
					if(enc){
						const contentDecoder=contentDecoderSelector(enc)/* ,
							contentEncoder=contentEncoderSelector(enc) */;
						streamChain.push(contentDecoder,streamModder/* ,contentEncoder */);
						delete headers['content-encoding'];
					}else{
						streamChain.push(streamModder);
					}
					//todo fix here
				}else if(streamModder instanceof Readable){//if the modder stream is just a readable stream, the stream will replace the raw data
					streamChain=[streamModder];
					delete headers['content-encoding'];
					//todo fix here
					/* if(enc){
						const contentEncoder=contentEncoderSelector(enc);
						streamChain.push(contentEncoder);
					} */
					resFromServer.on('data',()=>{});//consume source data
				}
			}
		}
		if(reqFromClient.errored || reqFromClient.closed){//close the response if the source has broken
			if(!resFromServer.destroyed)resFromServer.destroy();
			return;
		}
		if(reqFromClient.isHTTP2){
			delete headers['transfer-encoding'];//http2 dosen't support this header
		}
		for(let header in headers){
			resToClient.setHeader(header,headers[header]);
		}
		if(reqFromClient.isWebScoket){
			this.webSocketServer.handleUpgrade(reqFromClient, reqFromClient.socket, '', (ws)=>{
				ws.once('open',()=>{
				}).on('message',async (data,isBinary)=>{
					data=isBinary?data:data.toString();
					data=await (this.websocketModder?.(reqFromClient,'client',data)||data);
					reqToServer.send(data);
				});
				reqToServer.on('message',async (data,isBinary)=>{
					data=isBinary?data:data.toString();
					data=await (this.websocketModder?.(reqFromClient,'server',data)||data);
					ws.send(data);
				});
			});
		}else{
			resToClient.writeHead(resFromServer.statusCode);
			streamChain.push(resToClient);
			chainPipe(streamChain,(err)=>{
				if(this.httpLog){
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
	relayTCP(socket, rawAddress, rawPort, CMD_REPLY){
		let port;
		CMD_REPLY();//must reply the socks request first to get raw tcp stream
		this.socksLog&&console.log(`[TCP Relay]${rawAddress}:${rawPort}`);
		socket.once('readable', () => {
			let chunk = socket.read(15);
			if(chunk){//check connection protocol
				socket.unshift(chunk);//give back the chunk
				if(isHTTPHeader(chunk)){
					if(!this._httpReady){
						socket.destroy(new Error('http server not ready'));
						return;
					}
					port=this.httpPort;
				}else{
					if(!this._httpReady){
						socket.destroy(new Error('https server not ready'));
						return;
					}
					port=this.httpsPort;
				}
			}
			
			if(!port)return;
			let relay=new TCPRelay(socket, '127.0.0.1', port, CMD_REPLY);
			//set stream modder for tcp relay
			if(this.tcpOutGoingModder)relay.outModifier=new this.tcpOutGoingModder();
			if(this.tcpInComingModder)relay.outModifier=new this.tcpInComingModder();
			relay.once('connection',(socket,relaySocket)=>{
				this.socksLog&&console.log('[TCP]',`${socket.remoteAddress}:${socket.remotePort} ==> ${net.isIP(rawAddress)?'':'('+rawAddress+')'} ${relaySocket.remoteAddress}:${relaySocket.remotePort}`);
			}).on('proxy_error',(err,socket,relaySocket)=>{
				this.socksLog&&console.error('	[TCP proxy error]',`${relay.remoteAddress}:${relay.remotePort}`,err.message);
			}).once('close',e=>{
				let msg='';
				if(socket.remoteAddress)
					msg+=`${socket.remoteAddress}:${socket.remotePort} ==> `;
				if(relay.remoteAddress){
					msg+=`${net.isIP(rawAddress)?'':'('+rawAddress+')'} ${relay.remoteAddress}:${relay.remotePort}`;
				}else{
					msg+=`${rawAddress}:${port}`;
				}
				this.socksLog&&console.log('  [TCP closed]',msg);
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
	async _udpModder(fromClient,packet){
		if(this.udpModder){
			await this.udpModder(fromClient,packet);
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
	relayUDP(socket, address, port, CMD_REPLY){
		this.socksLog&&console.log(`[UDP Relay]${address}:${port}`);
		let relay=new UDPRelay(socket, address, port, CMD_REPLY);
		relay.on('proxy_error',(relaySocket,direction,err)=>{
			this.socksLog&&console.error('	[UDP proxy error]',`[${direction}]`,err.message);
		});
		relay.relaySocket.once('close',()=>{
			this.socksLog&&console.log('  [UDP closed]',socket.remoteAddress);
		});

		relay.packetHandler=this._udpModder.bind(this);
	}
	close(){
		this.socksServer.close();
		this.httpServer&&this.httpServer.close();
		this.httpsServer&&this.httpsServer.close();
	}
}

function contentDecoderSelector(enc){
	switch(enc){
		case 'gzip':return zlib.createUnzip();
		case 'deflate':return zlib.createInflate();
		case 'br':return zlib.createBrotliDecompress();
		default:throw(new Error('unknown encoding:'+enc));
	}
}
function contentEncoderSelector(enc){
	switch(enc){
		case 'gzip':return zlib.createGzip();
		case 'deflate':return zlib.createDeflate();
		case 'br':return zlib.createBrotliCompress();
		default:throw(new Error('unknown encoding:'+enc));
	}
}

function chainPipe(chain,cb){
	let lastStream,calledCb=false,i=0;
	for(let s of chain){
		if(lastStream)lastStream.pipe(s);
		lastStream=s;
		const ind=i++;
		s.once('error',err=>{
			err.streamIndex=ind;
			err.chainLength=chain.length;
			err.streamType=s.constructor?.name||'unknown';
			if(!calledCb){
				cb(err);
				calledCb=true;
			}
			for(let stream of chain){
				if(s===stream || stream.errored || stream.closed || stream.destroyed || stream.writableFinished)continue;
				stream.destroy(err);
			}
		});
	}
}

function isHTTPHeader(buf){
	let str=buf.toString();
	if(str.startsWith('GET')
	||str.startsWith('POST')
	||str.startsWith('HEAD')
	||str.startsWith('PUT')
	||str.startsWith('DELETE')
	||str.startsWith('CONNECT')
	||str.startsWith('OPTIONS')
	||str.startsWith('TRACE')
	||str.startsWith('PATCH'))
	return true;
	return false;
}

module.exports={
	SocksInTheMiddle,
	BufferModder,
}