const {SocksInTheMiddle,BufferModder}=require('./index'),
	fs=require('fs');
let server=new SocksInTheMiddle({
	socksPort:1099,
	socksHost:'0.0.0.0',
	httpPort:0,
	httpsPort:0,
	httpsOptions:{
		key:fs.readFileSync("E:/Dev/cert/server.key"),
		cert:fs.readFileSync('E:/Dev/cert/server.crt'),
		allowHTTP1:true,
	}
});

//HTTP modifier
server.setHTTPModder(async (headers,reqFromClient,resToClient)=>{//request modifier
	//you can change request headers here and they will be sent to target server
	// console.log(reqFromClient.url);
	// console.log('client request headers:',headers);

	reqFromClient;//Class: http.IncomingMessage [https://nodejs.org/dist/latest-v16.x/docs/api/http.html#class-httpincomingmessage]
	resToClient;//Class: http.ServerResponse [https://nodejs.org/dist/latest-v16.x/docs/api/http.html#class-httpserverresponse]

	//e.g. delete etag in header
	if(reqFromClient.url.startsWith('/favicon.ico')){
		delete headers['Etag'];
	}

	//If yout want to do a custom responding or to block the request, 
	//just operate the resToClient object like a common http response and return false here.
	// resToClient.end('blocked');
	// return false;//return false and the relay request will not be sent to the target server
	
	//If you want to edit request body, you can use a BufferModder, see below for example

},(headers,resFromServer,reqFromClient)=>{//response modifier
	//you can change response headers here and they will be sent back to client
	// console.log('server response headers:',headers);

	reqFromClient;//Class: http.IncomingMessage
	resFromServer;//Class: http.ClientRequest

	//You need to return a Transform stream for modifying the result, such as BufferModder in this module.
	//Decoded body stream will be piped to this Transform stream and then pipe to client response stream automatically.
	//If not stream returned, the data will not be modified.
	if(reqFromClient.url.startsWith('/?')){
		return new BufferModder(buf=>{
			let str=buf.toString();
			return str.replace(/更多/g,'超级多');//return a Buffer or a string is ok
		});
	}

	if(reqFromClient.url==='/nucleic-result?method=checkReportListByCode'){
		return new BufferModder(buf=>{
			let str=buf.toString();
			console.log(str);
			return str;//return a Buffer or a string is ok
		});
	}
});

//UDP modifier
server.setUDPModder(async (fromClient,packet)=>{
	//modify udp packet here
	fromClient;//is this packet from the client

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
	/* if(fromClient){
		packet.address='127.0.0.1';
		packet.port=12345;
	} */
});