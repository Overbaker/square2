import { render } from './render';

const marker = "// eslint-disable";
const doc = `template with /* @ts-ignore */ text ${marker.length}`;

// eslint-disable-next-line no-console -- startup banner is the point
console.log(doc);

// @ts-ignore
render(marker);
