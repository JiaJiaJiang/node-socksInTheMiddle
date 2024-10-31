const {
	SocksInTheMiddle,
	BufferModder,
	RequestOptions,//just import for type tip
	ResponseOptions,//just import for type tip
} = require('./index');
const fs = require('fs');
let server = new SocksInTheMiddle({
	socksPort: 1099,
	socksHost: '0.0.0.0',
	httpPort: 0,
	httpsPort: 0,
	httpsOptions: {
		key: fs.readFileSync("/your/path/to/server.key"),
		cert: fs.readFileSync('/your/path/to/server.crt'),
		allowHTTP1: true,
	}
});

const { Readable } = require('stream');

//HTTP modifier
server.setHTTPModder(async (reqOptions) => {//request modifier
	/* You can read or change request behaviour by setting reqOptions properities */
	//for more details, see RequestOptions class in index.js.
	reqOptions.method;// http method
	reqOptions.scheme;// "http"|"https"|"ws" etc.
	reqOptions.host;// target host, can contain port
	reqOptions.port;// target port
	reqOptions.path;// http path
	reqOptions.headers;// this is a cloned headers object from client request, you can modify it, but don't set pseudo-header headers here
	reqOptions.autoHttp2;// auto use http2 if target server support it, defaults to true
	reqOptions.passingOptions;// other options to be passed to the request method, depending on different protocol, this may contain different options

	/* Read only properities */
	reqOptions.clientHttpVersion;// client's http version， such as 1 or 2
	// request from client, this can be http.IncomingMessage or http2.IncomingMessage, depending on clientHttpVersion
	reqOptions.reqFromClient;
	// response to client, this can be http.OutgoingMessage or http2.OutgoingMessage, depending on clientHttpVersion
	reqOptions.resToClient;
	// extract hostname fron host properity
	reqOptions.hostname;
	// extract port fron port or host properity
	reqOptions.hostport;

	/* Methods */
	reqOptions.toURL();//construct a url string from object properties, this is only for debug, will not change relay behaviour

	/* Examples (each block is an example) */
	const {
		headers,
		reqFromClient,
		resToClient,
	} = reqOptions;
	{
		//delete etag in header
		if (reqOptions.path.startsWith('/favicon.ico')) {
			delete headers['Etag'];
		}
	}
	{
		//If yout want to do a custom responding or to block the request, 
		//just operate the resToClient object like a common http response and return false here.
		resToClient.end('blocked');
		//`return undefined` means their is no "body modder"
		return;
	}
	{
		//`return false` will block the request, no matter if the resToClient is ended or not
		return false;
	}
	{
		//If you want to edit request body, you can return a BufferModder, see below for example
		return new BufferModder(buf => {
			// buf is a Buffer object
			return buf;//return a Buffer or a string is ok
		});
	}
	// When returning to the request processing flow,
	// if the resToClient is ended by you or some other reason,
	// the relay request will not be sent to the target server

}, async (resOptions) => {//response modifier
	/* you can read or change response behaviour by setting resOptions properities */
	//for more details, see ResponseOptions class in index.js.
	resOptions.status;
	resOptions.headers;

	/* Read only properities */
	// the RequestOptions instance used by the relay
	resOptions.requestOptions;
	// target server's http version， such as 1 or 2
	resOptions.serverHttpVersion;
	// same as reqOptions.reqFromClient
	resOptions.reqFromClient;
	// same as reqOptions.resToClient
	resOptions.resToClient;
	// response from target server, this can be different class depending on serverHttpVersion
	resOptions.resFromServer;

	/* Examples (each block is an example) */
	const { requestOptions, headers, resFromServer, reqFromClient } = resOptions;
	{
		//you can change response headers here and they will be sent back to client
		// let the client don't cache this response
		headers['cache-control'] = 'no-cache';
	}
	{
		//You can return a Transform stream for modifying the result, such as BufferModder in this module.
		//Decoded body stream will be piped to this Transform stream and then pipe to client response stream automatically.
		//If not stream returned, the data will not be modified.
		if (requestOptions.path.startsWith('/?')) {
			//BufferModder is a convenient buffer collector that collect the whole response body
			return new BufferModder(buf => {
				let str = buf.toString();
				return str.replace(/更多/g, '超级多');//return a Buffer or a string is ok
			});
		}
	}
	{
		//If an Readable stream is returned, the response body from server will be ignored
		const stream=new Readable();
		stream.push(Math.random().toString());//push a random string to the stream
		stream.push(null);//end the readable stream
		return stream;//thsi steam will be pipe to client response
	}
});

//UDP modifier
server.setUDPModder(async (fromClient, packet) => {
	//modify udp packet here
	fromClient;//this is packet from the client

	// when fromClient is true
	packet.address;//target address
	packet.port;//target port
	packet.data;//client sent data

	// when fromClient is false
	packet.address;//source address
	packet.port;//source port
	packet.data;//data

	//If the packet was not from the client, modification on addreses and
	//port will not take effect, because the packet must be sent back
	//to the client

	//change target address
	if(fromClient){
		packet.address='127.0.0.1';
		packet.port=12345;
	}
});