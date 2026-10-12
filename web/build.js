const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'..');const src=path.join(root,'web');const out=path.join(root,'dist');
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
const files=['index.html','styles.css','app.js','safumode-mark.svg'];
for(const file of files)fs.copyFileSync(path.join(src,file),path.join(out,file));
console.log(`Built static site → ${out}`);
