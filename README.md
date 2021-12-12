# node-socksInTheMiddle
use a socks server for web request modification

This module starts a socks server and handle HTTP, HTTPS and UDP requests, it can be used to modify these requests and their responses.

TCP requests are only checked whether those are HTTP requests, or the request will be recognized as a HTTPS request, so don't send other protocols' requests to this server.

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
	socksPort:1090,//set a socks server port
	httpPort:0,//random port
	httpsPort:0,//random port
	httpsOptions:{
		key:fs.readFileSync("/your/path/to/server.key"),
		cert:fs.readFileSync('/your/path/to/server.crt'),
	}
});
```

Then set your application's socks5 proxy setting to `127.0.0.1:1090`.

If `http(s)Port` is not a number, the server will not be created. You must fill the `httpsOptions` option if you want to create a server that supports HTTPS protocol.

#### About Certificate

You can create a CA yourself and sign a certificate for the target domain then fill TLS options in `httpsOptions`.

### Modify HTTP request and response

```javascript
const {BufferModder}=require('socksInTheMiddle');
//HTTP modifier
server.setHTTPModder(async (headers,reqFromClient,resToClient)=>{//request modifier
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
