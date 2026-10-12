"use strict";

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { createManifest } = require("./deployment-manifest");

async function main() {
  if (hre.network.name !== "localhost") throw new Error("local manifest deployment requires --network localhost");
  const signers = await hre.ethers.getSigners();
  if (signers.length < 4) throw new Error("Hardhat node did not expose four development accounts");
  const params = {
    authorizer: await signers[1].getAddress(),
    recoveryAuthorizer: await signers[2].getAddress(),
    recoveryRecipient: await signers[3].getAddress(),
    delay: process.env.SAFUMODE_LOCAL_DELAY || "3600",
  };
  const factory = await hre.ethers.getContractFactory("AuthorizationVault", signers[0]);
  const vault = await factory.deploy(params.authorizer, params.recoveryAuthorizer, params.recoveryRecipient, params.delay);
  await vault.waitForDeployment();
  const manifest = await createManifest(vault, params, hre.ethers.provider);
  const output = path.resolve(process.env.SAFUMODE_MANIFEST || "deployments/hardhat-local.json");
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${output}`);
  console.log(`AuthorizationVault ${manifest.address}`);
  console.log(`Runtime ${manifest.runtimeCodeHash}`);
  console.log(`Build ${manifest.build.fingerprint}`);
}
main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
