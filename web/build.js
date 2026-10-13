const fs=require('fs');const path=require('path');
const root=path.resolve(__dirname,'..');const src=path.join(root,'web');const out=path.join(root,'dist');
fs.rmSync(out,{recursive:true,force:true});fs.mkdirSync(out,{recursive:true});
const files=['index.html','styles.css','hero.css','pages.css','story.js','home-extras.css','trace-polish.css','home-demo.js','app.js','deployment-allowlist.json','safumode-mark.svg','ethers.min.js'];
for(const file of files)fs.copyFileSync(path.join(src,file),path.join(out,file));
for(const route of ['how-it-works','security']){fs.mkdirSync(path.join(out,route));fs.copyFileSync(path.join(src,route,'index.html'),path.join(out,route,'index.html'));}
console.log(`Built static site → ${out}`);
