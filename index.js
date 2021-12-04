const net = require('net'),
	zlib = require('zlib'),
	http = require('http'),
	https = require('https'),
	{Transform,PassThrough} = require('stream'),
	pump = require('pump'),
	brotli = require('iltorb');
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
		super({highWaterMark:1638400});
		this.processer=processer;
		this.buf=[];
	}
	_transform(chunk, encoding, cb){
		this.buf.push(chunk);
		setImmediate(cb,null)
	}
	_flush(cb){
		let result=this.processer(Buffer.concat(this.buf));
		if(typeof result === 'string')result=Buffer.from(result);
		this.push(result);
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
	udpModder;
	httpServer;
	httpsServer;
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
			httpPort,
			httpsPort,
			httpsOptions,
		}=socksServerOptions;
		this.socksServer=createSocksServer(socksServerOptions);
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

		//create http server
		if(Number.isInteger(httpPort)){
			this.httpServer=http.createServer((req,res)=>this.dataModder(req,res,'http'))
			.listen(httpPort,'127.0.0.1',()=>{
				this._httpReady=true;
				this.socksLog&&console.log(`http server listening on : 127.0.0.1:${this.httpPort}`);
			});
		}
		//create https server
		if(Number.isInteger(httpsPort)){
			this.httpsServer=https.createServer(httpsOptions,(req,res)=>this.dataModder(req,res,'https'))
			.listen(httpsPort,'127.0.0.1',()=>{
				this._httpsReady=true;
				this.socksLog&&console.log(`http server listening on : 127.0.0.1:${this.httpsPort}`);
			});
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
	 * set a udp modify function
	 *
	 * @param {functoin} func
	 */
	setUDPModder(func){
		this.udpModder=func;
		return this;
	}
	dataModder(reqFromClient,resToClient,potocol){
		reqFromClient.potocol=potocol;
		this._requestModder(reqFromClient,resToClient,(reqToServer,resFromServer)=>{
			this._responseModder(resToClient,resFromServer,reqFromClient,reqToServer);
		});
	}
	async _requestModder(reqFromClient,resToClient,cb){
		let headers=Object.assign({},reqFromClient.headers),streamChain=[reqFromClient];
		if(this.requestModder){
			let streamModder=await this.requestModder(headers,reqFromClient,resToClient);
			if(streamModder){
				streamChain.push(streamModder);
			}else if(streamModder===false){
				return;
			}
		}
		let options={
			headers,
			method:reqFromClient.method,
			path:reqFromClient.url,
			hostname:headers.host,
			rejectUnauthorized:false
		};
		this.httpLog&&console.log('(proxy out)[ %s -> %s ] %s',reqFromClient.potocol+'://'+reqFromClient.headers.host,options.headers.host,options.path);
		let reqToServer=(reqFromClient.potocol=='http'?http:https).request(options,resFromServer=>{
			cb(reqToServer,resFromServer);
		}).on('error',e=>this.httpLog&&console.error('(proxy error)',reqFromClient.potocol+'://'+reqFromClient.headers.host,options.headers.host,options.path,e));
		streamChain.push(reqToServer);
		pump(...streamChain)
		return reqToServer;
	}
	async _responseModder(resToClient,resFromServer,reqFromClient,reqToServer){
		let headers=Object.assign({},resFromServer.headers),streamChain=[resFromServer];
		let contentDecoder=contentDecoderSelector(resFromServer);
		if(contentDecoder){
			delete headers['content-encoding'];
			streamChain.push(contentDecoder);
		}
		delete headers['content-length'];
		headers['transfer-encoding']='chunked';
		if(this.responseModder){
			let streamModder=await this.responseModder(headers,resFromServer,reqFromClient);
			if(streamModder){
				streamChain.push(streamModder);
			}
		}
		streamChain.push(resToClient);
		resToClient.writeHead(resFromServer.statusCode,resFromServer.statusMessage,Object.assign({},headers));
		pump(...streamChain);
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
			relay.on('connection',(socket,relaySocket)=>{
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

function contentDecoderSelector(sourceStream){
	let enc=sourceStream.headers['content-encoding'],
		stream;
	if(enc){
		switch(enc){
			case 'gzip':stream = zlib.createUnzip();break;
			case 'deflate':stream = zlib.createInflate();break;
			case 'br':stream = brotli.decompressStream();break;
			default:throw(new Error('unknown encoding:'+enc));
		}
	}
	return stream;
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