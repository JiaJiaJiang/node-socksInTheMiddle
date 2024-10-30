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
const fs=require('fs');
//HTTP modifier
server.setHTTPModder(async (headers,reqFromClient,resToClient,overrideRequestOptions)=>{//request modifier
	//you can modify request headers here and they will be sent to target server
	console.log('client request headers:',headers);

	reqFromClient;//Class: http.IncomingMessage [https://nodejs.org/dist/latest-v16.x/docs/api/http.html#class-httpincomingmessage]
	resToClient;//Class: http.ServerResponse [https://nodejs.org/dist/latest-v16.x/docs/api/http.html#class-httpserverresponse]

	//e.g. delete etag in request header when the url is '/favicon.ico'
	if(reqFromClient.url.startsWith('/favicon.ico')){
		delete headers['etag'];
	}

	//If yout want to do a custom respond or to block the request, 
	//just operate the resToClient object like a common http response.
	//If you want to handle this request asynchronously, return false here so the relay will not be created.
	resToClient.end('blocked');//If resToClient.end was called here, the relay request will not be created.
	return;

	//to override relay request options, fill this object
	overrideRequestOptions;//for (http||https).request method
	overrideRequestOptions.rejectUnauthorized=true;

	//change the request's path
	overrideRequestOptions.path='/blabla';
	//other options for http.request are also available
	
	//If you want to edit request body, you can use a BufferModder, see below for example
},(headers,resFromServer,reqFromClient)=>{//response modifier
	//you can modify response headers here and they will be sent back to client
	console.log('server response headers:',headers);

	reqFromClient;//Class: http.IncomingMessage
	resFromServer;//Class: http.ClientRequest

	//You need to return a Transform stream for modifying the result, such as BufferModder in this module.
	//Decoded body stream will be piped to this Transform stream and then pipe to client response stream automatically.
	//If no stream returned, the data will not be modified.
	if(reqFromClient.url.startsWith('/?')){
		return new BufferModder(buf=>{
			let str=buf.toString();
			return str.replace(/更多/g,'超级多');//return a Buffer or a string is ok
		});
	}else if(reqFromClient.url.startsWith('/test')){//Or return a Readable stream for an entirely new result
		return fs.createReadStream('path/to/test.txt');
	}
});
```

### Modify UDP request and response

```javascript
//UDP modifier
server.setUDPModder(async (fromClient,packet)=>{//modify udp packet here
	fromClient;//is this packet from the client

	//Change values of these properties to modify the message.
	//   If the packet was not from the client, modification on addreses and
	//   port will not take effect, because the packet must be sent back
	//   to the client.
	packet.address;//target address
	packet.port;//target port
	packet.data;//Buffer


	//change target address
	packet.address='127.0.0.1';
	packet.port=12345;
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
server.setHTTPModder(async (headers,reqFromClient,resToClient,overrideRequestOptions)=>{//request modifier
	//you can change request headers here and they will be sent to target server
	if(reqFromClient.url.startsWith('/taiko')){
		headers.host='taiko.luojia.me';
		headers.origin='https://luojia.me/';
		headers.referer='https://luojia.me/';
		Object.assign(overrideRequestOptions,{
			path:reqFromClient.url.replace(/^\/taiko/,''),
			protocol:'https',
		});
	}else{
		headers.host='luojia.me';
		Object.assign(overrideRequestOptions,{
			protocol:'https',
		});
	}

},(headers,resFromServer,reqFromClient)=>{//response modifier
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