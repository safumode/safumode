const { expect } = require("chai");
const { ethers } = require("hardhat");
const { prepare, relay, verifySignatures } = require("../scripts/safumode-tx");
const { loadBuildIdentity } = require("../scripts/deployment-manifest");
const { relayerIndex } = require("../scripts/safumode-cli");

describe("SAFUMODE offline preparation and guarded relay", function () {
  let vault, manifest, authorizer, recovery, recipient, target, relayer, wrong;
  const delay=60;
  beforeEach(async function () {
    [,authorizer,recovery,recipient,target,relayer,wrong]=await ethers.getSigners();
    vault=await ethers.deployContract("AuthorizationVault",[authorizer.address,recovery.address,recipient.address,delay]);
    const addr=await vault.getAddress(), code=await ethers.provider.getCode(addr);
    manifest={schema:"safumode-local-deployment-v1",environment:"hardhat-local-only",chainId:"31337",address:addr,
      runtimeCodeHash:ethers.keccak256(code),constructor:{authorizer:authorizer.address,recoveryAuthorizer:recovery.address,recoveryRecipient:recipient.address,delay:String(delay)},
      build:loadBuildIdentity()};
  });
  async function deadline(){return String((await ethers.provider.getBlock("latest")).timestamp+1000);}
  async function signed(action,input) {
    const bundle=prepare(manifest,action,input);
    const signatures={};
    for(const [role] of Object.entries(bundle.expectedSigners)) signatures[role]=await ({authorizer,recoveryAuthorizer:recovery}[role]).signTypedData(bundle.domain,bundle.types,bundle.message);
    return {bundle,signatures};
  }
  async function send(action,input){const x=await signed(action,input); return relay(x.bundle,manifest,x.signatures,ethers.provider,relayer,{rpcUrl:"http://127.0.0.1",relayerAddress:relayer.address,dryRun:false});}

  it("prepares deterministic schedule typed data and relays it",async function(){
    const input={asset:ethers.ZeroAddress,to:target.address,amount:"1",nonce:"1",deadline:await deadline()};
    expect(prepare(manifest,"schedule",input)).to.deep.equal(prepare(manifest,"schedule",input));
    const result=await send("schedule",input); expect(result.dryRun).false;
    expect(await vault.authorizerNonceUsed(1)).true;
  });
  it("relays a trusted immediate withdraw",async function(){
    await authorizer.sendTransaction({to:vault,value:5n}); const d=await deadline();
    const t=await signed("trust",{account:target.address,trusted:true,nonce:1,deadline:d});
    await relay(t.bundle,manifest,t.signatures,ethers.provider,relayer,{rpcUrl:"http://localhost",relayerAddress:relayer.address});
    await ethers.provider.send("evm_increaseTime",[delay]); await ethers.provider.send("evm_mine"); await vault.activateTrust(target,1);
    await send("withdraw",{asset:ethers.ZeroAddress,to:target.address,amount:2,nonce:2,deadline:await deadline()});
    expect(await ethers.provider.getBalance(vault)).equal(3n);
  });
  it("relays trust additions and revocations",async function(){
    await send("trust",{account:target.address,trusted:true,nonce:1,deadline:await deadline()});
    await send("trust",{account:target.address,trusted:false,nonce:2,deadline:await deadline()});
    expect(await vault.trustNonce(target)).equal(2n);
  });
  it("relays recovery",async function(){
    await authorizer.sendTransaction({to:vault,value:4n}); const before=await ethers.provider.getBalance(recipient);
    await send("recover",{asset:ethers.ZeroAddress,amount:4,nonce:1,deadline:await deadline()});
    expect(await ethers.provider.getBalance(recipient)).equal(before+4n);
  });
  it("relays cancellation by recovery authority",async function(){
    const s=await signed("schedule",{asset:ethers.ZeroAddress,to:target.address,amount:1,nonce:1,deadline:await deadline()});
    const id=await vault.scheduleWithdrawal.staticCall(s.bundle.message.asset,s.bundle.message.to,1,1,s.bundle.message.deadline,s.signatures.authorizer);
    await relay(s.bundle,manifest,s.signatures,ethers.provider,relayer,{rpcUrl:"http://localhost",relayerAddress:relayer.address});
    await send("cancel",{requestId:id,byRecovery:true,nonce:1,deadline:await deadline()});
    expect((await vault.requests(id)).cancelled).true;
  });
  it("relays pause",async function(){
    await send("pause",{paused:true,byRecovery:true,nonce:1,deadline:await deadline()}); expect(await vault.paused()).true;
  });
  it("relays authority rotation scheduling",async function(){
    const signers=await ethers.getSigners();
    await send("rotate",{authorizer:signers[7].address,recoveryAuthorizer:signers[8].address,nonce:1,deadline:await deadline()});
    expect((await vault.pendingRotation()).nonce).equal(1n);
  });
  it("rejects malicious typed-field substitution",async function(){
    const x=await signed("recover",{asset:ethers.ZeroAddress,amount:1,nonce:1,deadline:await deadline()});
    x.bundle.message.amount="2";
    expect(()=>verifySignatures(x.bundle,x.signatures)).to.throw("wrong signer");
    await expect(relay(x.bundle,manifest,x.signatures,ethers.provider,relayer,{rpcUrl:"http://localhost",relayerAddress:relayer.address})).to.be.rejectedWith("wrong signer");
  });
  it("rejects a wrong signer and any public relay use",async function(){
    const x=await signed("schedule",{asset:ethers.ZeroAddress,to:target.address,amount:1,nonce:1,deadline:await deadline()});
    x.signatures.authorizer=await wrong.signTypedData(x.bundle.domain,x.bundle.types,x.bundle.message);
    expect(()=>verifySignatures(x.bundle,x.signatures)).to.throw("wrong signer");
    const good=await signed("schedule",{asset:ethers.ZeroAddress,to:target.address,amount:1,nonce:1,deadline:await deadline()});
    await expect(relay(good.bundle,manifest,good.signatures,ethers.provider,relayer,{rpcUrl:"https://public.example",relayerAddress:relayer.address,dryRun:false})).to.be.rejectedWith("local-only");
    expect(await vault.authorizerNonceUsed(1)).false;
  });
  it("rejects a tampered build fingerprint",async function(){
    const bad=structuredClone(manifest); bad.build.fingerprint="0x"+"00".repeat(32);
    expect(()=>prepare(bad,"schedule",{asset:ethers.ZeroAddress,to:target.address,amount:1,nonce:1,deadline:"1"})).to.throw("does not match local artifacts");
  });
  it("requires an explicit relay URL",async function(){
    const x=await signed("schedule",{asset:ethers.ZeroAddress,to:target.address,amount:1,nonce:1,deadline:await deadline()});
    await expect(relay(x.bundle,manifest,x.signatures,ethers.provider,null,{dryRun:true})).to.be.rejectedWith("rpcUrl is required");
  });
  it("rejects stale signer metadata after authority rotation",async function(){
    const input={asset:ethers.ZeroAddress,to:target.address,amount:1,nonce:2,deadline:await deadline()};
    const oldBundle=prepare(manifest,"schedule",input,{version:"1:1"});
    const old={bundle:oldBundle,signatures:{authorizer:await authorizer.signTypedData(oldBundle.domain,oldBundle.types,oldBundle.message)}};
    const signers=await ethers.getSigners();
    await send("rotate",{authorizer:signers[7].address,recoveryAuthorizer:signers[8].address,nonce:1,deadline:await deadline()});
    await ethers.provider.send("evm_increaseTime",[delay]); await ethers.provider.send("evm_mine"); await vault.activateRotation(1);
    await expect(relay(old.bundle,manifest,old.signatures,ethers.provider,null,{rpcUrl:"http://localhost",dryRun:true})).to.be.rejectedWith("stale signer metadata");
  });
  it("rejects a relayer that differs from the explicit address",async function(){
    const x=await signed("schedule",{asset:ethers.ZeroAddress,to:target.address,amount:1,nonce:1,deadline:await deadline()});
    await expect(relay(x.bundle,manifest,x.signatures,ethers.provider,relayer,{rpcUrl:"http://localhost",relayerAddress:wrong.address})).to.be.rejectedWith("does not match explicit");
  });
  it("rejects malformed relayer indexes",function(){
    for(const value of ["-1","1.5","1x","01",true]) expect(()=>relayerIndex(value)).to.throw("relayer-index");
  });
});
