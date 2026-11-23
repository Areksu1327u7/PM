const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path');
const {gzip}=require('node:zlib'),{promisify}=require('node:util');
const compress=promisify(gzip),root=path.resolve(__dirname,'..');
function createServer(){
 const assets=new Map();
 return http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',"frame-ancestors 'none'");
  if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{Allow:'GET, HEAD'});return res.end();}
  let name;try{name=decodeURIComponent(req.url.split('?')[0]);}catch{res.writeHead(400);return res.end();}
  const file=path.resolve(root,'.'+(name==='/'?'/index.html':name)),ext=path.extname(file);
  if(!file.startsWith(root+path.sep)||name.includes('/.')||!['.html','.css','.js','.ico'].includes(ext)){res.writeHead(403);return res.end();}
  try{
   const stat=await fs.stat(file);if(!stat.isFile()){res.writeHead(404);return res.end();}
   const etag=`W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
   const cacheable=ext!=='.html';
   res.setHeader('Cache-Control',cacheable?'public, max-age=0, must-revalidate':'no-store');
   res.setHeader('Vary','Accept-Encoding');
   if(cacheable){res.setHeader('ETag',etag);if(req.headers['if-none-match']===etag){res.writeHead(304);return res.end();}}
   let asset=assets.get(file);
   if(!asset||asset.etag!==etag){
    const raw=await fs.readFile(file);asset={etag,raw,gzip:raw.length>1024?await compress(raw):null};
    if(cacheable){if(assets.size>=64)assets.delete(assets.keys().next().value);assets.set(file,asset);}
   }
   const useGzip=asset.gzip&&/\bgzip\b(?!\s*;\s*q=0(?:\.0*)?(?:\s*,|\s*$))/i.test(req.headers['accept-encoding']||'');
   const body=useGzip?asset.gzip:asset.raw;
   res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'})[ext]||'image/x-icon');
   if(useGzip)res.setHeader('Content-Encoding','gzip');res.setHeader('Content-Length',body.length);
   res.end(req.method==='HEAD'?undefined:body);
  }catch{if(!res.headersSent)res.writeHead(404);res.end();}
 });
}
module.exports={createServer};
if(require.main===module)createServer().listen(4173,'127.0.0.1',()=>console.log('Tienda: http://127.0.0.1:4173'));
