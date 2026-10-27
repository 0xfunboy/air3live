/** Three.js r186 FBX importer adapter for Unreal custom scalar curves. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createFBXImporter(threePath) {
  const threeVersion = JSON.parse(fs.readFileSync(path.join(threePath, 'package.json'), 'utf8')).version;
  if (threeVersion !== '0.186.1') throw new Error(`Expected three 0.186.1, found ${threeVersion}`);
  const THREE = await import(pathToFileURL(path.join(threePath, 'build/three.module.js')).href);

  // Unreal emits hundreds of scalar custom-property curves. The upstream loader
  // loosely accepts names containing R/S/T, then dereferences unsupported nodes.
  // Apply the two narrowly scoped adaptations to an in-memory module. The
  // installed dependency is never edited; custom properties are exported below.
  let loaderSource = fs.readFileSync(path.join(threePath, 'examples/jsm/loaders/FBXLoader.js'), 'utf8');
  function replaceExactly(from, to) {
    if (loaderSource.split(from).length !== 2) throw new Error('FBXLoader source has changed; review adapter');
    loaderSource = loaderSource.replace(from, to);
  }
  replaceExactly("from 'three'", `from '${pathToFileURL(path.join(threePath, 'build/three.module.js')).href}'`);
  replaceExactly("from '../libs/fflate.module.js'", `from '${pathToFileURL(path.join(threePath, 'examples/jsm/libs/fflate.module.js')).href}'`);
  replaceExactly("from '../curves/NURBSCurve.js'", `from '${pathToFileURL(path.join(threePath, 'examples/jsm/curves/NURBSCurve.js')).href}'`);
  replaceExactly('rawCurveNode.attrName.match( /S|R|T|DeformPercent/ )', 'rawCurveNode.attrName.match( /^(S|R|T|DeformPercent)$/ )');
  replaceExactly('const animationCurveRelationship = relationships.parents[ 0 ].relationship;',
    'const animationCurveRelationship = relationships.parents[ 0 ].relationship;\n\t\t\t\tif (!curveNodesMap.has(animationCurveID)) continue;');
  replaceExactly('export { FBXLoader };', 'export { FBXLoader }; export const getParsedTree = () => fbxTree;');
  const { FBXLoader, getParsedTree } = await import(`data:text/javascript;base64,${Buffer.from(loaderSource).toString('base64')}`);
  return { THREE, FBXLoader, getParsedTree, threeVersion };
}
