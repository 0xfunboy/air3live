import re,json,numpy as np
from pathlib import Path
from scipy.spatial.transform import Rotation as R
from sparsify_glb import BinaryGLTF

def read_bvh(path):
 text=Path(path).read_text(); h,m=text.split('MOTION'); tokens=re.findall(r'[^\s{}]+|[{}]',h);idx=1;nodes=[];channel=0
 def node(parent):
  nonlocal idx,channel
  kind=tokens[idx];idx+=1
  name=tokens[idx] if kind!='End' else (nodes[parent]['name']+'End');idx+=1
  assert tokens[idx]=='{';idx+=1
  n={'name':name,'parent':parent,'offset':None,'channels':[],'index':len(nodes)};i=len(nodes);nodes.append(n)
  while tokens[idx]!='}':
   t=tokens[idx]
   if t=='OFFSET':n['offset']=np.array(list(map(float,tokens[idx+1:idx+4])))*.01;idx+=4
   elif t=='CHANNELS':
    count=int(tokens[idx+1]);n['channels']=tokens[idx+2:idx+2+count];n['channel']=channel;channel+=count;idx+=2+count
   elif t in ('JOINT','End'):node(i)
   else:raise ValueError(t)
  idx+=1
 node(None)
 lines=m.strip().splitlines();dt=float(lines[1].split(':')[1]);frames=np.loadtxt(lines[2:]);f=len(frames)
 qs=np.zeros((f,len(nodes),4));ps=np.zeros((f,len(nodes),3));local=[]
 for i,n in enumerate(nodes):
  ch=n['channels'];off=n['offset'];lq=R.identity(f)
  if ch:
   data=frames[:,n['channel']:n['channel']+len(ch)];rots=[(j,c[0]) for j,c in enumerate(ch) if c.endswith('rotation')];lq=R.from_euler(''.join(c for _,c in rots),data[:,[j for j,_ in rots]],degrees=True)
  if n['parent'] is None:ps[:,i]=frames[:,:3]*.01;qs[:,i]=lq.as_quat()
  else:
   par=n['parent'];pq=R.from_quat(qs[:,par]);ps[:,i]=ps[:,par]+pq.apply(off);qs[:,i]=(pq*lq).as_quat()
  local.append(lq.as_quat())
 return nodes,dt,frames,ps,qs

# Offline retargeter. Run from the project root with numpy and scipy installed.
# The input BVH rotations are preserved; this is not a gait synthesizer.
import struct,hashlib

BASE=Path(__file__).resolve().parent.parent
SOURCE=BASE/'source-assets/motion/accad-female1'
MODEL=BASE/'studio-broadcast/public/assets/air3/models/AIR3-runtime.glb'
OUTPUT=BASE/'studio-broadcast/public/assets/air3/motion/accad-female1.mjs'

def unit(a):
 a=np.asarray(a);return a/max(1e-12,np.linalg.norm(a))
def between(a,b):
 a=unit(a);b=unit(b);c=np.cross(a,b);w=1+np.dot(a,b)
 if w<1e-8:
  c=np.cross(a,[0,1,0]);
  if np.linalg.norm(c)<1e-5:c=np.cross(a,[1,0,0])
  return R.from_rotvec(unit(c)*np.pi)
 return R.from_quat(np.r_[c,w]/np.linalg.norm(np.r_[c,w]))
def qslerp(a,b,t):
 return (a*(R.from_rotvec((a.inv()*b).as_rotvec()*t)))

def load_target():
 b=MODEL.read_bytes();size=struct.unpack_from('<I',b,12)[0];d=json.loads(b[20:20+size]);ns=d['nodes'];par={}
 for i,n in enumerate(ns):
  for c in n.get('children',[]):par[c]=i
 wq={};wp={}
 def calc(i):
  if i in wq:return
  n=ns[i];q=R.from_quat(n.get('rotation',[0,0,0,1]));p=np.array(n.get('translation',[0,0,0]))
  if i in par:
   calc(par[i]);p=wp[par[i]]+wq[par[i]].apply(p);q=wq[par[i]]*q
  wq[i]=q;wp[i]=p
 for i in range(len(ns)):calc(i)
 ix={n['name'][6:]:i for i,n in enumerate(ns) if n.get('name','').startswith('body__') and i!=0}
 return ns,par,wq,wp,ix

def generate():
 ns,par,restq,restp,tix=load_target();sn,_,_,sp,standq=read_bvh(SOURCE/'Female1_A01_Stand.bvh');six={n['name']:i for i,n in enumerate(sn)}
 target_file=BinaryGLTF(MODEL);target_idle=next(a for a in target_file.doc['animations'] if a['name']=='MH_Idle01_UE')
 idle_rotations={target_file.doc['nodes'][c['target']['node']]['name'][6:]:R.from_quat(target_file.accessor(target_idle['samplers'][c['sampler']]['output'])[0]) for c in target_idle['channels'] if c['target']['path']=='rotation' and target_file.doc['nodes'][c['target']['node']]['name'].startswith('body__')}
 src_rest_y=float(np.median(sp[:,0,1]));leg_ratio=((restp[tix['thigh_l']]-restp[tix['calf_l']]).dot(restp[tix['thigh_l']]-restp[tix['calf_l']])**.5+np.linalg.norm(restp[tix['calf_l']]-restp[tix['foot_l']]))/(np.linalg.norm(sn[six['LeftLeg']]['offset'])+np.linalg.norm(sn[six['LeftFoot']]['offset']))
 mapping={'pelvis':'Hips','spine_01':'ToSpine','spine_02':'Spine','spine_03':'Spine','spine_04':'Spine1','spine_05':'Spine1','neck_01':'Neck','neck_02':'Neck','head':'Head'}
 children={}
 for side,prefix in [('l','Left'),('r','Right')]:
  for tb,sb,tc,sc in [('clavicle','Shoulder','upperarm','Arm'),('upperarm','Arm','lowerarm','ForeArm'),('lowerarm','ForeArm','hand','Hand'),('hand','Hand','middle_03','HandEnd'),('thigh','UpLeg','calf','Leg'),('calf','Leg','foot','Foot'),('foot','Foot','ball','ToeBase'),('ball','ToeBase','bigtoe_01','ToeBaseEnd')]:
   name=tb+'_'+side;mapping[name]=prefix+sb;children[name]=(tc+'_'+side,prefix+sc)
 bones=list(mapping);align={}
 for name,(tc,sc) in children.items():
  if tc not in tix:
   tc='bigtoe_01_'+name[-1]
  td=restp[tix[tc]]-restp[tix[name]];sd=sn[six[sc]]['offset'];align[name]=between(td,sd)
 # A capture subject's clavicle alignment is not the target's shoulder rest.
 # Preserve the target idle baseline and apply only the small recorded change.
 # Upper-arm world orientations are still retargeted independently below.
 shoulder_reference={}
 for side,prefix in [('l','Left'),('r','Right')]:
  name='clavicle_'+side
  parent=R.from_quat(standq[:,six['Spine1']])*restq[tix['spine_05']]
  clavicle=R.from_quat(standq[:,six[prefix+'Shoulder']])*align[name]*restq[tix[name]]
  shoulder_reference[name]=(parent.inv()*clavicle).mean()
 clips={};stats=[]
 # Start/end frames are selected from the recorded actions. Continuous walking
 # is a complete same-foot cycle; a small endpoint correction is distributed smoothly across the cycle.
 specs=[('stand','A01_Stand',0,90,True),('start','B01_StandToWalk',20,78,False),('walk','B03_Walk1',92,129,True),('stop','B02_WalkToStandT2',91,147,False),('turnLeft','B09_WalkTurnLeft90',110,132,False),('turnRight','B12_WalkTurnRight90',95,117,False),('turnAround','B15_WalkTurnAround180',150,201,False),('turnAroundRight','B15_WalkTurnAround180',150,201,False)]
 for key,stem,start,end,loop in specs:
  path=SOURCE/('Female1_'+stem+'.bvh');nodes,dt,frames,pos,quat=read_bvh(path);indices=np.arange(start,end+1);p=pos[indices];q=quat[indices];count=len(indices)
  mirrored=key=='turnAroundRight'
  if mirrored:
   # Reflect the measured capture before retargeting and exchange left/right
   # joints. The target bind skeleton remains untouched. A clockwise route
   # turn must not reuse counter-clockwise foot placement unchanged.
   source_index={n['name']:i for i,n in enumerate(nodes)}
   opposite=lambda name:'Right'+name[4:] if name.startswith('Left') else 'Left'+name[5:] if name.startswith('Right') else name
   swap=[source_index[opposite(n['name'])] for n in nodes]
   reflection=np.diag([-1,1,1])
   p=p[:,swap].copy();p[:,:,0]*=-1
   matrices=R.from_quat(q[:,swap].reshape(-1,4)).as_matrix()
   q=R.from_matrix(reflection@matrices@reflection).as_quat().reshape(count,len(nodes),4)
  rootforward=R.from_quat(q[:,0]).apply(np.array([0,0,1]));headings=np.unwrap(np.arctan2(rootforward[:,0],rootforward[:,2]));
  # Remove heading from the pose. Route steering owns only this world yaw; all
  # recorded pelvic roll/pitch and relative limb/foot rotations remain intact.
  displacement=p[-1,0]-p[0,0]
  basis_heading=np.arctan2(displacement[0],displacement[2]) if key not in ['stand'] and not key.startswith('turn') else np.median(headings)
  normalization=headings if key.startswith('turn') else np.full(count,basis_heading)
  invheading=R.from_rotvec(np.c_[np.zeros(count),-normalization,np.zeros(count)])
  canonicalq={n['name']:invheading*R.from_quat(q[:,i]) for i,n in enumerate(nodes)}
  canonicalp=invheading.apply(p[:,0]-p[:,0])
  desired={}
  for name,sname in mapping.items():
   sq=canonicalq[sname]
   if name=='spine_01':sq=qslerp(canonicalq['Hips'],canonicalq['Spine'],.16)
   elif name=='spine_02':sq=qslerp(canonicalq['Hips'],canonicalq['Spine'],.60)
   elif name=='spine_03':sq=qslerp(canonicalq['Spine'],canonicalq['Spine1'],.32)
   elif name=='spine_04':sq=qslerp(canonicalq['Spine'],canonicalq['Spine1'],.72)
   elif name=='neck_01':sq=qslerp(canonicalq['Spine1'],canonicalq['Neck'],.55)
   elif name=='neck_02':sq=canonicalq['Neck']
   desired[tix[name]]=sq*align.get(name,R.identity())*restq[tix[name]]
  for side in ['l','r']:
   name='clavicle_'+side;parent=desired[tix['spine_05']]
   local=parent.inv()*desired[tix[name]]
   delta=(shoulder_reference[name].inv()*local).as_rotvec()
   lengths=np.linalg.norm(delta,axis=1);delta*=np.minimum(1,np.deg2rad(12)/np.maximum(lengths,1e-9))[:,None]
   desired[tix[name]]=parent*idle_rotations[name]*R.from_rotvec(delta*.35)
  worlds={};locals={};positions={}
  def target(i):
   if i in worlds:return
   n=ns[i];pq=R.identity(count);pp=np.zeros((count,3))
   if i in par:target(par[i]);pq=worlds[par[i]];pp=positions[par[i]]
   lq=R.from_quat(n.get('rotation',[0,0,0,1]));posi=np.broadcast_to(n.get('translation',[0,0,0]),(count,3)).copy()
   if i in desired:lq=pq.inv()*desired[i]
   if i==tix['pelvis']:
    posi[:,1]+=(p[:,0,1]-src_rest_y)*leg_ratio
    # Preserve the source side-to-side weight transfer after removing travel.
    rootdelta=p[:,0]-p[0,0];forward0=np.array([np.sin(basis_heading),0,np.cos(basis_heading)]);right0=np.array([forward0[2],0,-forward0[0]])
    lateral=rootdelta@right0;trend=np.linspace(lateral[0],lateral[-1],count);posi[:,0]+=(lateral-trend)*leg_ratio
   worlds[i]=pq*lq;positions[i]=pp+pq.apply(posi);locals[i]=lq
  for i in tix.values():target(i)
  # Remove optical capture floor drift using the calibrated target foot/toe
  # support points. No per-bone scale, joint translation or invented foot arcs.
  floors=[]
  for side in ['l','r']:
   floors.append(positions[tix['foot_'+side]][:,1]-restp[tix['foot_'+side]][1])
   floors.append(positions[tix['ball_'+side]][:,1]-restp[tix['ball_'+side]][1])
  floor=np.min(np.stack(floors),axis=0)
  pelvis=np.broadcast_to(ns[tix['pelvis']]['translation'],(count,3)).copy()
  pelvis[:,1]+=(p[:,0,1]-src_rest_y)*leg_ratio-floor
  pelvis[:,0]=positions[tix['pelvis']][:,0]
  source_floor=np.min(np.stack([p[:,six[prefix+joint],1]-np.median(sp[:,six[prefix+joint],1]) for prefix in ['Left','Right'] for joint in ['Foot','ToeBase']]),axis=0)
  contacts=[]; supports=[]
  for side,prefix in [('l','Left'),('r','Right')]:
   foot=p[:,six[prefix+'Foot']];toe=p[:,six[prefix+'ToeBase']]
   fv=np.linalg.norm(np.gradient(foot[:,[0,2]],axis=0),axis=1)/dt
   tv=np.linalg.norm(np.gradient(toe[:,[0,2]],axis=0),axis=1)/dt
   fc=foot[:,1]-np.median(sp[:,six[prefix+'Foot'],1])-source_floor
   tc=toe[:,1]-np.median(sp[:,six[prefix+'ToeBase'],1])-source_floor
   fv=np.where(fc<.025,fv,np.inf);tv=np.where(tc<.025,tv,np.inf)
   use_toe=tv<fv
   contact=(np.minimum(fv,tv)<.12)
   contacts.append(contact.astype(float));supports.append(use_toe.astype(int))
  qs=[]
  for name in bones:
   values=locals[tix[name]].as_quat()
   for f in range(1,count):
    if np.dot(values[f-1],values[f])<0:values[f]*=-1
   if loop:
    # A smooth additive closure is distributed over the recorded cycle. This
    # avoids the visible foot-speed spike of a short end-only crossfade.
    phase=np.linspace(0,1,count);weight=phase*phase*(3-2*phase)
    closure=R.from_quat(values[-1]).inv()*R.from_quat(values[0])
    values=(R.from_quat(values)*R.from_rotvec(weight[:,None]*closure.as_rotvec())).as_quat()
   qs.append(np.round(values,7).tolist())
  if loop:
   phase=np.linspace(0,1,count);weight=(phase*phase*(3-2*phase))[:,None]
   pelvis+=weight*(pelvis[0]-pelvis[-1])
   for c in contacts:c[-1]=c[0]
   for c in supports:c[-1]=c[0]
  if key.startswith('turn'):roottravel=np.linalg.norm(np.diff(p[:,0][:,[0,2]],axis=0),axis=1)*leg_ratio
  else:
   forward=np.array([np.sin(basis_heading),0,np.cos(basis_heading)]);roottravel=np.maximum(0,np.diff(p[:,0],axis=0)@forward)*leg_ratio
  distance=np.r_[0,np.cumsum(roottravel)];speed=np.r_[roottravel[0],roottravel]/dt
  if key=='stand':speed*=0;distance*=0
  clips[key]={'source':path.name,'startFrame':start,'endFrame':end,'fps':round(1/dt),'duration':round((count-1)*dt,7),'loop':loop,'rootDistance':round(float(distance[-1]),5),'meanSpeed':round(float(np.mean(speed)),5),'yawChange':round(float(headings[-1]-headings[0]),6),'yaw':np.round(headings-headings[0],7).tolist(),'pelvis':np.round(pelvis,6).tolist(),'quaternions':qs,'contacts':np.stack(contacts,axis=1).tolist(),'supports':np.stack(supports,axis=1).tolist(),'distance':np.round(distance,6).tolist(),'speed':np.round(speed,5).tolist()}
  stats.append({'id':key,'source':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'frames':[start,end],'samples':count,'duration':clips[key]['duration'],'rootDistance':clips[key]['rootDistance'],'meanSpeed':clips[key]['meanSpeed'],'mirrored':mirrored})
 rest={name:{'position':ns[i].get('translation',[0,0,0]),'quaternion':ns[i].get('rotation',[0,0,0,1]),'scale':ns[i].get('scale',[1,1,1])} for name,i in tix.items()}
 variants={'turnAroundRight':clips.pop('turnAroundRight')}
 variant_stats=[stats.pop()]
 calibration={'reference':'MH_Idle01_UE frame 0','shoulderDeltaScale':.35,'maximumShoulderDeltaDegrees':4.2,'turnSteps':{'turnLeft':1,'turnRight':1,'turnAround':2,'turnAroundRight':2}}
 data={'schema':'air3.accad-retarget.v2','source':'ACCAD / The Ohio State University, Open Motion Project, Female 1','license':'CC-BY-3.0','sourceUrl':'https://accad.osu.edu/research/motion-lab/mocap-system-and-data','targetSha256':hashlib.sha256(MODEL.read_bytes()).hexdigest(),'bones':bones,'rest':rest,'legScale':leg_ratio,'calibration':calibration,'clips':clips,'variants':variants}
 OUTPUT.parent.mkdir(parents=True,exist_ok=True);OUTPUT.write_text('// Generated by tools/retarget_accad_motion.py from recorded ACCAD BVH data.\n// Motion data: ACCAD / The Ohio State University, CC BY 3.0.\nexport const ACCAD_MOTION = '+json.dumps(data,separators=(',',':'))+';\n')
 manifest={'schema':data['schema'],'targetSha256':data['targetSha256'],'sourceUrl':data['sourceUrl'],'license':'https://creativecommons.org/licenses/by/3.0/','archiveUrl':'https://accad.osu.edu/sites/accad.osu.edu/files/Female1_bvh.zip','archiveSha256':'84543297a24fe9900449675837b5b7758c5208d0f56b699d10a3eb362a46530a','targetBones':bones,'legScale':leg_ratio,'calibration':calibration,'method':'World-space bind-axis retarget; target-idle shoulder baseline plus bounded recorded variation; finite one/two-step turn intervals and reflected clockwise variant; locomotion yaw separated; optical floor drift correction; distributed smooth loop closure; no synthetic gait','clips':stats,'variants':variant_stats,'outputBytes':OUTPUT.stat().st_size,'outputSha256':hashlib.sha256(OUTPUT.read_bytes()).hexdigest()}
 (SOURCE/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps(manifest,indent=2))
if __name__=='__main__':generate()
