# node-socksInTheMiddle
use a socks server for web request modification

This module starts a socks server and handle HTTP, HTTPS, WebSocket and UDP requests, it can be used to modify these requests and their responses.

TCP requests are only checked whether those are HTTP requests, or the request will be recognized as a HTTPS request, so don't send other protocols' requests to this server.

**This module can just be a HTTP interceptor or HTTP proxy server without socks part.**

## Install

```shell
npm i socksinthemiddle
```



## Examples



### Launch a server

```javascript
const {SocksInTheMiddle}=require('socksInTheMiddle');
const fs=require('fs');
let server=new SocksInTheMiddle({
	socksPort:1090,//set a socks server port, set to false to disable this server
	httpPort:0,//random port, set to false to disable this server
	httpsPort:0,//random port, set to false to disable this server
	httpsOptions:{//options for https server
		key:fs.readFileSync("/your/path/to/server.key"),
		cert:fs.readFileSync('/your/path/to/server.crt'),
	}
});
```

Then set your application's socks5 proxy setting to `127.0.0.1:1090`.

If `http(s)Port` or the `socksPort` is not a number, that server will not be created. You must fill the `httpsOptions` option if you want to create a server that supports HTTPS protocol.

#### About Certificate

You can create a CA yourself and sign a certificate for the target domain then fill TLS options in `httpsOptions`.

### Modify HTTP request and response

##### server.setHTTPModder(requestModder : Function, responseModder : Function)

Both modder functions can modify http headers for the request or the response.

If the function returns a Transform stream, raw data will be piped in and the stream will be piped to the target.

If the function returns just a Readable stream, raw data will be ignored, and the stream will be piped to the target.

```javascript
const {BufferModder}=require('socksInTheMiddle');
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
```

### Modify UDP request and response

```javascript
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
```

### Modify WebSocket message

```javascript
//The websocket modifier is just for websocket messages, to modify http header or url, do it in HTTP modifier
server.setWebSocketModder((req,source,data)=>{
	/* 
		req: reqFromClient
		source: where do this message from: 'client' || 'server'
		data: websocket data, if received binary data, it will be a Buffer object, otherwise a string
	*/
	console.log(source,data);
	return data;//return any data what you want
});
```

### Just use this module as a HTTP interceptor

You can ignore the socks part and just use this module as a HTTP interceptor or HTTP proxy server.

```javascript
const {SocksInTheMiddle,BufferModder}=require('socksinthemiddle');
let server=new SocksInTheMiddle({
	socksPort:false,//set here to false so the socks server will not start
	httpPort:5607,
	httpsPort:false,//if this option is enabled,you should also set httpsOptions
	httpLog:true,
});

//HTTP modifier
server.setHTTPModder(async (reqOptions)=>{//request modifier
	const {
		headers,
		reqFromClient,
		resToClient,
	}=reqOptions;
	//you can change request headers here and they will be sent to target server
	if(reqOptions.path.startsWith('/taiko')){
		reqOptions.scheme='https';
		reqOptions.host='taiko.luojia.me';
		reqOptions.path=reqOptions.path.replace(/^\/taiko/,'');
		headers.origin='https://luojia.me/';
		headers.referer='https://luojia.me/';
	}else{
		reqOptions.host='luojia.me';
		reqOptions.scheme='https';
	}

},(resOptions)=>{//response modifier
	const {
		headers,
		resFromServer,
		reqFromClient,
	}=resOptions;
	const mime=headers['content-type'];
	if(!mime)return;
	if (mime.endsWith('javascript')|| mime.startsWith('text') || mime.endsWith('json')) {
		return new BufferModder(buf=>{
			let str=buf.toString();
			return str.replaceAll('https://taiko.luojia.me','/taiko');//replace target domain in text responses
		});
	}
});
```

Then you can visit `http://127.0.0.1:5607` for the proxied website.

# Ver 3.0: Breaking changes

To make the program logic clearer and increase compatibility with different http versions, the parameters of "reqMod" and "resMod" function for the setHTTPModder method are changed to a "RequestOptions" object(for reqMod) and a "ResponseOptions" object(for resMod).