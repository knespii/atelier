import {
    REACHED, dropFromDock, entryPoint, windowClosing, windowFromDock, windowFromMiddle,
} from '../lib/windowLiquid.js';
import {assert, assertEqual} from './util.js';

const icon = {x: 900, y: 1000, width: 64, height: 64};
const frame = {x: 600, y: 200, width: 700, height: 500};
const actor = {x: 580, y: 180, width: 740, height: 540};
const params = {icon, side: 'BOTTOM', frame, actor, drop: 14, blend: 16, radius: 12};

export function testEntryPoint() {
    assertEqual(entryPoint(icon, frame), [932, 700], 'the point of the window nearest to the icon');
    assertEqual(entryPoint({x: 0, y: 0, width: 10, height: 10}, frame), [600, 200]);
}

export function testDropFromDock() {
    assertEqual(dropFromDock(params, 0).boxes, [], 'nothing yet');
    const {boxes, capsules} = dropFromDock(params, 0.2);
    assert(boxes.length === 1 && boxes[0][1] < icon.y && capsules.length === 1, 'swelling over the icon, on a neck');
    const flying = dropFromDock(params, 0.48);
    assert(flying.capsules.length === 0 && flying.boxes[0][1] < 1000 && flying.boxes[0][1] > 600, 'let go, on its way');
    assertEqual(dropFromDock(params, 1).boxes, [], 'gone into the window');
}

export function testWindowFromDock() {
    assertEqual(windowFromDock(params, 0.3).boxes, [], 'hidden until the drop reaches it');
    const [box] = windowFromDock(params, REACHED + 0.05).boxes;
    assert(box[2] < frame.width / 2 && box[3] < frame.height / 2, 'spreading from where it came in');
    assertEqual(windowFromDock(params, 1).boxes, [[370, 270, 370, 270, 0, 0]], 'all of it, its shadow too');
}

export function testFromMiddleAndClosing() {
    assertEqual(windowFromMiddle(frame, actor, 12, 0).boxes, [], 'nothing yet');
    assertEqual(windowFromMiddle(frame, actor, 12, 1).boxes, [[370, 270, 370, 270, 0, 0]], 'all of it');
    const [half] = windowFromMiddle(frame, actor, 12, 0.15).boxes;
    assert(Math.abs(half[0] - 370) < 1 && half[2] < 350, 'out of its middle');
    assertEqual(windowClosing({x: 20, y: 20, width: 700, height: 500}, 12, 1).boxes, [], 'closed: gone');
}
