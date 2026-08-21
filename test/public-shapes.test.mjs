import { publicValue } from "../dist/tools/common.js";

const source = {
	registryRef: "workspace/template:latest",
	session: {
		sourceRegistryImageId: "image-id",
		sourceRegistryWorkspaceId: "workspace-id",
		sourceRegistryRef: "workspace/template:latest",
	},
	rows: [{ source_registry_ref: "workspace/template:latest" }],
};

const result = publicValue(source);
const encoded = JSON.stringify(result);

if (/registry/i.test(encoded)) {
	throw new Error(`public response leaked internal field names: ${encoded}`);
}
if (result.image !== source.registryRef) throw new Error("registryRef was not exposed as image");
if (result.session.sourceImageId !== "image-id") throw new Error("source image id was not normalized");
if (result.session.sourceImageWorkspaceId !== "workspace-id") throw new Error("source image workspace was not normalized");
if (result.session.sourceImage !== source.registryRef) throw new Error("source image was not normalized");
if (result.rows[0].source_image !== source.registryRef) throw new Error("snake-case source image was not normalized");

console.log("✓ internal image fields use public session/template terminology");
