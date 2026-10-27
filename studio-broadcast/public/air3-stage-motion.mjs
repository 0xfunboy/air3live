import * as THREE from 'three';
import { Air3MocapLocomotion, planCaptureJourney } from './air3-locomotion.mjs';

const UP = new THREE.Vector3(0, 1, 0);
const clamp = THREE.MathUtils.clamp;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const yawQuaternion = angle => new THREE.Quaternion().setFromAxisAngle(UP, angle);
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const worldPosition = node => node.getWorldPosition(new THREE.Vector3());
const worldQuaternion = node => node.getWorldQuaternion(new THREE.Quaternion());

function roundedRoute(points, radius = .34) {
  if (points.length < 3) return points.map(p => p.clone());
  const result = [points[0].clone()];
  for (let i = 1; i < points.length - 1; i++) {
    const corner = points[i], previous = points[i - 1], next = points[i + 1];
    const trim = Math.min(radius, previous.distanceTo(corner) * .3, corner.distanceTo(next) * .3);
    const enter = corner.clone().lerp(previous, trim / corner.distanceTo(previous));
    const exit = corner.clone().lerp(next, trim / corner.distanceTo(next));
    result.push(enter);
    for (let sample = 1; sample <= 14; sample++) {
      const t = sample / 14;
      result.push(enter.clone().multiplyScalar((1-t)**2).addScaledVector(corner, 2*t*(1-t)).addScaledVector(exit,t*t));
    }
  }
  result.push(points.at(-1).clone()); return result;
}

function setWorldQuaternion(node, quaternion, weight = 1) {
  const desired = worldQuaternion(node.parent).invert().multiply(quaternion).normalize();
  node.quaternion.slerp(desired, clamp(weight, 0, 1));
  node.updateWorldMatrix(false, true);
}

/** Analytic two-bone IK from the actual skeleton lengths and directions.
 * No assumptions about +X/-X Unreal joint axes, no bone scaling or translation.
 * The pole is a world position. The returned reach error is measured, not hidden.
 */
export function solveTwoBoneIK(upper, lower, end, target, pole, { weight = 1, endQuaternion = null } = {}) {
  if (!upper || !lower || !end || weight <= 0) return null;
  upper.updateWorldMatrix(true, true);
  const a = worldPosition(upper), b = worldPosition(lower), c = worldPosition(end);
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  if (!(l1 > 1e-6 && l2 > 1e-6)) return null;
  const direction = target.clone().sub(a), requestedDistance = direction.length();
  if (requestedDistance < 1e-6) return null;
  direction.multiplyScalar(1 / requestedDistance);
  const distance = clamp(requestedDistance, Math.abs(l1 - l2) + 1e-5, (l1 + l2) * .998);
  const poleDirection = pole.clone().sub(a).addScaledVector(direction, -pole.clone().sub(a).dot(direction));
  if (poleDirection.lengthSq() < 1e-8) poleDirection.copy(UP).addScaledVector(direction, -UP.dot(direction));
  if (poleDirection.lengthSq() < 1e-8) poleDirection.set(1, 0, 0).addScaledVector(direction, -direction.x);
  poleDirection.normalize();
  const along = (l1 * l1 + distance * distance - l2 * l2) / (2 * distance);
  const bend = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const elbow = a.clone().addScaledVector(direction, along).addScaledVector(poleDirection, bend);
  const upperDelta = new THREE.Quaternion().setFromUnitVectors(b.clone().sub(a).normalize(), elbow.clone().sub(a).normalize());
  setWorldQuaternion(upper, upperDelta.multiply(worldQuaternion(upper)), weight);
  const actualB = worldPosition(lower), actualC = worldPosition(end);
  const reachable = a.clone().addScaledVector(direction, distance);
  const lowerDelta = new THREE.Quaternion().setFromUnitVectors(actualC.sub(actualB).normalize(), reachable.sub(actualB).normalize());
  setWorldQuaternion(lower, lowerDelta.multiply(worldQuaternion(lower)), weight);
  if (endQuaternion) setWorldQuaternion(end, endQuaternion, weight);
  return { error: worldPosition(end).distanceTo(target), clamped: requestedDistance > distance + 1e-5,
    upperLength: l1, lowerLength: l2 };
}

function addWorldOffset(node, offset) {
  const position = worldPosition(node).add(offset);
  node.position.copy(node.parent.worldToLocal(position)); node.updateWorldMatrix(false, true);
}

function pointHandQuaternion(hand, bones, side, direction) {
  const middle = bones.get('middle_03_' + side), index = bones.get('index_01_' + side), pinky = bones.get('pinky_01_' + side);
  if (!middle || !index || !pinky) return worldQuaternion(hand);
  const inverse = worldQuaternion(hand).invert();
  const localForward = worldPosition(middle).sub(worldPosition(hand)).applyQuaternion(inverse).normalize();
  const across = worldPosition(index).sub(worldPosition(pinky)).applyQuaternion(inverse).normalize();
  const localNormal = across.clone().cross(localForward).normalize();
  if (side === 'r') localNormal.negate();
  const localSide = localNormal.clone().cross(localForward).normalize();
  localNormal.copy(localForward).cross(localSide).normalize();
  const forward = direction.clone().normalize();
  const normal = new THREE.Vector3(0, 1, .30).addScaledVector(forward, -new THREE.Vector3(0, 1, .30).dot(forward)).normalize();
  const lateral = normal.clone().cross(forward).normalize(); normal.copy(forward).cross(lateral).normalize();
  const localQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(localSide, localNormal, localForward));
  const worldQ = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(lateral, normal, forward));
  return worldQ.multiply(localQ.invert()).normalize();
}

/** Stage navigation over recorded female motion capture.
 * Root travel, start/stop and limb poses come from ACCAD recordings. IK is used
 * only to stabilize the recorded stance contacts and the existing monitor hand.
 */
export class Air3StageMotion {
  constructor(rig, avatar, layout) {
    this.rig=rig; this.avatar=avatar; this.layout=layout; this.time=0; this.phase='home'; this.enabled=false; this.disposed=false;
    this.path=[]; this.history=[new THREE.Vector3().fromArray(layout.home)]; this.targetId=null; this.pendingId=null; this.returning=false;
    this.heading=avatar.rotation.y; this.targetHeading=this.heading; this.maximumSpeed=.94; this.speed=0; this.turnRate=1.15;
    this.walkWeight=0; this.turnWarp=0; this.pointWeight=0; this.stanceFlex=0; this.nextAutomaticAt=35; this.autoIndex=0; this.arrivedAt=0;
    this.originalGroundFeet=rig.groundFeet; this.contactErrors={l:0,r:0}; this.maxContactError=0; this.maxStanceDrift=0; this.contactReachReleases=0; this.stepNumber=0; this.legs={}; this.arms={};
    this.pelvis=rig.bodyBones.get('pelvis'); this.locomotion=new Air3MocapLocomotion(rig); this.travelState='stand'; this.transitionCount=0;
    avatar.updateWorldMatrix(true,true);
    this.originalRootPosition=rig.root.position.clone(); this.referencePelvisQuaternion=this.pelvis?.quaternion.clone();
    // Mesh bounds are asymmetric (hair, hands and garment). Their centre is
    // not an anatomical turning axis. Centre this stage holder on the pelvis
    // projection once, with a rigid horizontal translation of the whole model.
    if(this.pelvis){const center=worldPosition(avatar),pelvis=worldPosition(this.pelvis);addWorldOffset(rig.root,new THREE.Vector3(center.x-pelvis.x,0,center.z-pelvis.z));}
    const inverseAvatar=worldQuaternion(avatar).invert();
    this.scale=rig.root.getWorldScale(new THREE.Vector3()).y / avatar.getWorldScale(new THREE.Vector3()).y;
    this.pelvisRestHeight=this.pelvis?worldPosition(this.pelvis).y-avatar.position.y:0;
    for(const side of ['l','r']) {
      const upper=rig.bodyBones.get('thigh_'+side), lower=rig.bodyBones.get('calf_'+side), end=rig.bodyBones.get('foot_'+side);
      if(!upper||!lower||!end)continue;
      const position=worldPosition(end); this.legs[side]={upper,lower,end,anchor:position.clone(),position:position.clone(),offset:avatar.worldToLocal(position.clone()),
        ankleHeight:position.y-avatar.position.y,quaternion:worldQuaternion(end),relativeQuaternion:inverseAvatar.clone().multiply(worldQuaternion(end)),stance:false,contactWeight:0};
      const armUpper=rig.bodyBones.get('upperarm_'+side),armLower=rig.bodyBones.get('lowerarm_'+side),hand=rig.bodyBones.get('hand_'+side);
      if(armUpper&&armLower&&hand)this.arms[side]={upper:armUpper,lower:armLower,hand};
    }
    this.ready=this.locomotion.ready&&!!this.pelvis&&Object.keys(this.legs).length===2;
    if(this.ready)rig.setBodyPoseLayer(dt=>this.applyPose(dt));
  }
  get moving(){return this.phase==='walking'||this.phase==='turning';}
  presentMonitor(id){
    if(!this.ready||!Object.hasOwn(this.layout.monitorSpots,id))return false;
    if(this.targetId===id&&['walking','turning','presenting'].includes(this.phase)&&!this.returning)return true;
    this.nextAutomaticAt=this.time+40;const home=new THREE.Vector3().fromArray(this.layout.home);
    if(this.avatar.position.distanceTo(home)>.06||this.moving||this.phase==='presenting'){this.pendingId=id;this.beginReturn();}
    else this.beginOutbound(id);return true;
  }
  beginOutbound(id){
    this.targetId=id;this.pendingId=null;this.returning=false;
    this.path=roundedRoute(this.layout.routes[id].map(p=>new THREE.Vector3().fromArray(p)));this.history=[new THREE.Vector3().fromArray(this.layout.home)];
    this.trimPath();this.startJourney();
  }
  beginReturn(){
    if(this.returning)return;this.returning=true;this.targetId=null;
    this.path=this.history.slice().reverse().map(p=>p.clone());const home=new THREE.Vector3().fromArray(this.layout.home);
    if(!this.path.length||this.path.at(-1).distanceTo(home)>.01)this.path.push(home);
    this.trimPath();this.startJourney();
  }
  returnHome(){if(!this.ready)return false;this.pendingId=null;this.nextAutomaticAt=this.time+40;if(this.phase!=='home')this.beginReturn();return true;}
  setEnabled(value){this.enabled=!!value;this.nextAutomaticAt=this.time+35;return this.enabled;}
  trimPath(){while(this.path.length&&this.path[0].distanceTo(this.avatar.position)<.006)this.path.shift();}
  remainingDistance(){let length=0,last=this.avatar.position;for(const point of this.path){length+=last.distanceTo(point);last=point;}return length;}
  aimAtPath(){if(this.path.length){const d=this.path[0].clone().sub(this.avatar.position);this.targetHeading=Math.atan2(d.x,d.z);}}
  setCapture(id,options){
    if(id!==this.locomotion.id||options?.restart){
      this.transitionCount++;
      // A different action can have a different stance width or foot roll.
      // Release its old support over the same continuous pose blend and then
      // acquire the new support, rather than dragging an obsolete anchor.
      for(const leg of Object.values(this.legs)){leg.stance=false;leg.transitionReleaseWeight=leg.contactWeight;leg.contactOffTime=0;}
    }
    return this.locomotion.setClip(id,options);
  }
  startJourney(){
    this.rig.groundFeet=false;this.speed=0;this.aimAtPath();
    if(!this.path.length){this.arrive();return;}
    if(Math.abs(angleDelta(this.heading,this.targetHeading))>.22){this.beginTurn('travel');}
    else this.beginWalk();
  }
  beginTurn(purpose){
    this.phase='turning';this.turnPurpose=purpose;this.travelState='turn';this.turnStarted=this.time;this.speed=0;
    const angle=angleDelta(this.heading,this.targetHeading);
    const twoSteps=this.returning&&Math.abs(angle)>1.4;
    const id=twoSteps?(angle>=0?'turnAround':'turnAroundRight'):angle>=0?'turnLeft':'turnRight';
    this.setCapture(id,{restart:true,blend:.24});
    this.turnPlan={startHeading:this.heading,delta:angle,targetHeading:this.targetHeading,steps:twoSteps?2:1,progress:0,
      duration:twoSteps?1.65:Math.max(.78,Math.abs(angle)/2.8),pivot:worldPosition(this.pelvis).toArray()};
  }
  beginWalk(){
    this.phase='walking';this.travelState='start';this.journeyPlan=planCaptureJourney(this.remainingDistance());
    this.captureRate=clamp(this.maximumSpeed/(this.locomotion.referenceWalkSpeed*this.journeyPlan.strideScale),.25,1.6);
    this.setCapture('start',{restart:true,blend:.25});
  }
  beginStop(){
    this.travelState='stop';this.changeWalkingCapture('stop',{restart:true,blend:.22});
  }
  changeWalkingCapture(id,options){
    const previousSpeed=this.locomotion.speedAt()*this.captureRate;
    this.setCapture(id,options);
    this.captureRate=clamp(previousSpeed/Math.max(.01,this.locomotion.speedAt()),.25,1.6);
  }
  moveAlongPath(distance){
    let remaining=distance;
    while(remaining>1e-8&&this.path.length){
      const destination=this.path[0],delta=destination.clone().sub(this.avatar.position),length=delta.length();
      if(length<=remaining+.00001){this.avatar.position.copy(destination);remaining-=length;const point=this.path.shift();if(!this.returning)this.history.push(point.clone());}
      else{this.avatar.position.addScaledVector(delta,remaining/length);remaining=0;}
    }
  }
  arrive(){
    this.speed=0;
    if(this.returning)this.targetHeading=.05;
    else{const target=new THREE.Vector3().fromArray(this.layout.monitorTargets[this.targetId]).sub(this.avatar.position);this.targetHeading=clamp(Math.atan2(target.x,target.z),-1.2,1.2);}
    if(Math.abs(angleDelta(this.heading,this.targetHeading))>.08)this.beginTurn('arrival');else this.finishArrival();
  }
  finishArrival(){
    this.setCapture('stand',{restart:true,blend:.35});this.travelState='stand';this.speed=0;
    if(this.returning){this.phase='home';this.returning=false;this.history=[new THREE.Vector3().fromArray(this.layout.home)];this.rig.clearAttentionTarget();
      if(this.pendingId){const id=this.pendingId;this.pendingId=null;this.beginOutbound(id);}}
    else{this.phase='presenting';this.arrivedAt=this.time;this.nextAutomaticAt=this.time+20;}
  }
  update(dt){
    if(this.disposed||!this.ready)return;dt=clamp(Number.isFinite(dt)?dt:0,0,.1);this.time+=dt;
    if(this.enabled&&!this.rig.speaking&&this.time>=this.nextAutomaticAt){if(this.phase==='home')this.presentMonitor(['left','center','right'][this.autoIndex++%3]);else if(this.phase==='presenting')this.returnHome();this.nextAutomaticAt=this.time+40;}
    this.walkWeight=THREE.MathUtils.damp(this.walkWeight,this.phase==='home'?0:1,8,dt);
    this.turnWarp=THREE.MathUtils.damp(this.turnWarp,this.phase==='turning'?1:0,9,dt);
    if(this.phase==='turning'){
      this.locomotion.advance(dt,this.locomotion.clip.duration/this.turnPlan.duration);
      const yaw=this.locomotion.yawAt(this.locomotion.time),total=this.locomotion.clip.yawChange;
      this.turnPlan.progress=Math.max(this.turnPlan.progress,clamp(yaw/total,0,1));
      this.heading=this.turnPlan.startHeading+this.turnPlan.delta*smooth(this.turnPlan.progress);
      if(this.locomotion.finished){this.heading=this.turnPlan.targetHeading;if(this.turnPurpose==='travel')this.beginWalk();else this.finishArrival();}
    }else if(this.phase==='walking'){
      this.aimAtPath();const turn=angleDelta(this.heading,this.targetHeading);this.heading+=clamp(turn,-1.8*dt,1.8*dt);
      const spatialScale=this.journeyPlan.strideScale; // Already fits metres in this avatar's world.
      const playbackRate=this.maximumSpeed/(this.locomotion.referenceWalkSpeed*spatialScale);
      this.captureRate=THREE.MathUtils.damp(this.captureRate,clamp(playbackRate*clamp(1-Math.abs(turn)/.9,.4,1),.25,1.6),7,dt);
      let remainingTime=dt,movement=0;
      for(let split=0;split<4&&remainingTime>1e-8&&this.phase==='walking';split++){
        const boundary=this.travelState==='walk'?this.journeyPlan.walkEnd:this.locomotion.clip.duration;
        const used=Math.min(remainingTime,Math.max(0,(boundary-this.locomotion.time)/this.captureRate));
        if(used>0){const delta=this.locomotion.advance(used,this.captureRate)*spatialScale;movement+=delta;this.moveAlongPath(delta);remainingTime-=used;}
        if(this.locomotion.time>=boundary-1e-7){
          if(this.travelState==='start'){this.travelState='walk';this.changeWalkingCapture('walk',{restart:true,phase:this.journeyPlan.entry,blend:.20});}
          else if(this.travelState==='walk')this.beginStop();
          else{this.arrive();}
        }else break;
      }
      this.speed=dt>0?movement/dt:0;
    }else{this.locomotion.advance(dt,1);this.speed=0;}
    this.heading=Math.atan2(Math.sin(this.heading),Math.cos(this.heading));this.avatar.rotation.y=this.heading;this.avatar.updateWorldMatrix(true,true);
    this.rig.groundFeet=this.walkWeight<.001?this.originalGroundFeet:false;
    this.pointWeight=THREE.MathUtils.damp(this.pointWeight,this.phase==='presenting'?.82:0,5,dt);
    const forward=new THREE.Vector3(Math.sin(this.heading),0,Math.cos(this.heading));
    if(this.moving){const gaze=this.avatar.position.clone().addScaledVector(forward,3);gaze.y=1.55;this.rig.setAttentionTarget(gaze,{kind:'travel',weight:.86});}
    else if(this.phase==='presenting'&&(this.time-this.arrivedAt)%9<1.4)this.rig.setAttentionTarget(new THREE.Vector3().fromArray(this.layout.monitorTargets[this.targetId]),{kind:'monitor',weight:.68});
    else this.rig.clearAttentionTarget();
  }
  applyPose(dt=0){
    if(!this.ready||this.walkWeight<.0001)return;
    this.locomotion.apply(this.walkWeight);
    if(this.turnWarp>.001){
      this.pelvis.quaternion.slerp(this.referencePelvisQuaternion,.72*this.turnWarp*this.walkWeight);
      this.pelvis.updateWorldMatrix(false,true);
      const center=worldPosition(this.avatar),pelvis=worldPosition(this.pelvis);
      addWorldOffset(this.pelvis,new THREE.Vector3(center.x-pelvis.x,0,center.z-pelvis.z).multiplyScalar(this.turnWarp*this.walkWeight));
    }
    const forward=new THREE.Vector3(Math.sin(this.heading),0,Math.cos(this.heading)),right=new THREE.Vector3(Math.cos(this.heading),0,-Math.sin(this.heading));
    // The source turns were captured while travelling. In a narrow studio an
    // in-place orientation change needs shorter strides. Spatial warping keeps
    // the recorded timing, pole directions, foot roll and weight shifts; it
    // scales the recorded ankle excursion, never creates a new gait curve.
    if(this.turnWarp>.001){
      const poses=Object.entries(this.legs).map(([side,leg])=>({side,leg,foot:worldPosition(leg.end),knee:worldPosition(leg.lower),hip:worldPosition(leg.upper),quaternion:worldQuaternion(leg.end)}));
      for(const {side,leg,foot,knee,hip,quaternion}of poses){
        const local=this.avatar.worldToLocal(foot.clone()),targetLocal=local.clone();
        const stride=1-.68*this.turnWarp,lift=1-.40*this.turnWarp;
        targetLocal.x=leg.offset.x+(local.x-leg.offset.x)*stride;
        targetLocal.z=leg.offset.z+(local.z-leg.offset.z)*stride;
        targetLocal.y=leg.offset.y+(local.y-leg.offset.y)*lift;
        const target=this.avatar.localToWorld(targetLocal),pole=knee.clone().addScaledVector(knee.clone().sub(hip.clone().lerp(foot,.5)).normalize(),.20);
        solveTwoBoneIK(leg.upper,leg.lower,leg.end,target,pole,{weight:this.walkWeight,endQuaternion:quaternion});
      }
    }
    // Contacts use the slower grounded heel/forefoot marker in the source.
    // Preserve foot roll by anchoring that support point, not the whole ankle.
    const plans=[];let drop=0;
    for(const [index,side]of ['l','r'].entries()){
      const leg=this.legs[side],foot=worldPosition(leg.end),knee=worldPosition(leg.lower),hip=worldPosition(leg.upper);
      const captureSettled=this.locomotion.blendElapsed>=this.locomotion.blendTime;
      const capturedContact=captureSettled&&this.locomotion.contacts[index]>.72&&this.walkWeight>.99;
      leg.contactOffTime=capturedContact?0:(leg.contactOffTime??0)+dt;
      // Optical markers can briefly alternate between heel and forefoot at
      // roll-over. A sub-80ms gap must not unlock and reacquire the same step.
      const heldContact=captureSettled&&leg.stance&&leg.contactOffTime<.08;
      const contact=(capturedContact||heldContact)&&this.phase!=='home',supportId=this.locomotion.supports[index];
      const supportNode=supportId?this.rig.bodyBones.get('ball_'+side):leg.end,support=worldPosition(supportNode);
      if(contact&&!leg.stance){leg.anchor.copy(support);this.stepNumber++;}
      else if(leg.supportNode&&leg.supportId!==supportId){
        // Heel/toe roll changes the marker, not the planted shoe position.
        // Transfer the current correction to the new marker instead of
        // teleporting the foot back to its uncorrected capture pose.
        const previousSupport=worldPosition(leg.supportNode);
        leg.anchor.add(support).sub(previousSupport);
      }
      leg.supportNode=supportNode;
      leg.supportId=supportId;leg.stance=contact;
      if(!captureSettled&&leg.transitionReleaseWeight>0){
        leg.contactWeight=leg.transitionReleaseWeight*(1-smooth(this.locomotion.blendElapsed/this.locomotion.blendTime));
      }else{
        leg.transitionReleaseWeight=0;
        leg.contactWeight=THREE.MathUtils.damp(leg.contactWeight,contact?1:0,contact?30:14,clamp(dt,0,.1));
      }
      leg.quaternion.copy(worldQuaternion(leg.end));const target=foot.clone();
      if(leg.contactWeight>.001){target.x+=(leg.anchor.x-support.x)*leg.contactWeight;target.z+=(leg.anchor.z-support.z)*leg.contactWeight;}
      const reach=hip.distanceTo(knee)+knee.distanceTo(foot),horizontal=Math.hypot(target.x-hip.x,target.z-hip.z);
      if(contact&&leg.contactWeight>.9){const available=Math.sqrt(Math.max(0,(reach*.995)**2-horizontal*horizontal));drop=Math.max(drop,hip.y-target.y-available);}
      const pole=knee.clone().addScaledVector(knee.clone().sub(hip.clone().lerp(foot,.5)).normalize(),.20);
      leg.poleTarget=pole;
      plans.push({side,leg,foot,knee,hip,target,pole,contact,supportNode,reach});
    }
    // Limb proportions differ slightly between capture performer and avatar.
    // At most 20mm of pelvis reach correction maintains support without bone
    // stretching. It is zero when the recorded pose already reaches the floor.
    const desiredDrop=clamp(drop,0,.020)*this.walkWeight;
    this.pelvisDrop=THREE.MathUtils.damp(this.pelvisDrop??0,desiredDrop,desiredDrop>(this.pelvisDrop??0)?22:8,clamp(dt,0,.1));
    if(this.pelvisDrop>0)addWorldOffset(this.pelvis,new THREE.Vector3(0,-this.pelvisDrop,0));
    for(const {side,leg,foot,knee,target,pole,contact,supportNode,reach}of plans){
      const hip=worldPosition(leg.upper);
      if(hip.distanceTo(target)>reach*.995){
        const vertical=hip.y-target.y,horizontal=Math.hypot(target.x-hip.x,target.z-hip.z),allowed=Math.sqrt(Math.max(0,(reach*.995)**2-vertical*vertical));
        if(horizontal>allowed&&horizontal>1e-6){target.x=hip.x+(target.x-hip.x)*allowed/horizontal;target.z=hip.z+(target.z-hip.z)*allowed/horizontal;}
        if(contact)this.contactReachReleases++;
      }
      // Weight the support correction in target space. A pelvis reach
      // correction must not turn a fading contact back into a fully locked
      // foot, which otherwise snaps when its tiny residual weight expires.
      const ikWeight=this.pelvisDrop>0||leg.contactWeight>.001?this.walkWeight:0;
      if(ikWeight>.001){
        const result=solveTwoBoneIK(leg.upper,leg.lower,leg.end,target,pole,{weight:ikWeight,endQuaternion:leg.quaternion});
        this.contactErrors[side]=result?.error??0;
        if(contact&&leg.contactWeight>.99){this.maxContactError=Math.max(this.maxContactError,this.contactErrors[side]);const actual=worldPosition(supportNode);this.maxStanceDrift=Math.max(this.maxStanceDrift,Math.hypot(actual.x-leg.anchor.x,actual.z-leg.anchor.z));}
      }else this.contactErrors[side]=0;
      leg.position.copy(target);
    }
    if(this.pointWeight>.001&&this.targetId){
      const screen=new THREE.Vector3().fromArray(this.layout.monitorTargets[this.targetId]),local=this.avatar.worldToLocal(screen.clone()),side=local.x>=0?'l':'r',arm=this.arms[side];
      if(arm){const shoulder=worldPosition(arm.upper),elbow=worldPosition(arm.lower),wrist=worldPosition(arm.hand),reach=(shoulder.distanceTo(elbow)+elbow.distanceTo(wrist))*.86,direction=screen.clone().sub(shoulder).normalize(),target=shoulder.clone().addScaledVector(direction,reach);
        const pole=shoulder.clone().addScaledVector(right,side==='l'?.35:-.35).addScaledVector(forward,.22);pole.y-=.3;
        solveTwoBoneIK(arm.upper,arm.lower,arm.hand,target,pole,{weight:this.pointWeight,endQuaternion:pointHandQuaternion(arm.hand,this.rig.bodyBones,side,direction)});this.pointingSide=side;}
    }
  }
  afterRigUpdate(){}
  diagnostics(){return{ready:this.ready,enabled:this.enabled,phase:this.phase,moving:this.moving,target:this.targetId,pendingTarget:this.pendingId,returning:this.returning,position:this.avatar.position.toArray(),heading:this.heading,speed:this.speed,steps:this.stepNumber,
    contacts:Object.fromEntries(Object.entries(this.legs).map(([side,leg])=>[side,{stance:leg.stance,target:leg.position.toArray(),errorMetres:this.contactErrors[side]}])),
    maximumPlantedAnkleErrorMetres:this.maxContactError,maximumStanceAnchorDriftMetres:this.maxStanceDrift,contactReachReleases:this.contactReachReleases,pelvisDrop:this.pelvisDrop??0,stanceMinimumFlexMetres:0,pointWeight:this.pointWeight,pointingSide:this.pointingSide??null,
    travelState:this.travelState,turnStrideScale:1-.68*this.turnWarp,turnPlan:this.turnPlan?{steps:this.turnPlan.steps,duration:this.turnPlan.duration,progress:this.turnPlan.progress}:null,
    journeyPlan:this.journeyPlan?{strideScale:this.journeyPlan.strideScale,entry:this.journeyPlan.entry,exit:this.journeyPlan.exit,cycles:this.journeyPlan.cycles}:null,
    transitions:this.transitionCount,locomotion:this.locomotion.diagnostics(),method:'Recorded ACCAD Female 1 BVH, calibrated shoulder baseline, central one/two-step turns, phase-matched finite action sequence, continuous captured-pose blending and measured support stabilization',motionCapture:true,syntheticGait:false,clothSimulation:false};}
  dispose(){this.disposed=true;this.rig.setBodyPoseLayer(null);this.rig.groundFeet=this.originalGroundFeet;this.rig.clearAttentionTarget();this.rig.root.position.copy(this.originalRootPosition);this.rig.root.updateWorldMatrix(true,true);}
}
