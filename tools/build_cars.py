"""Build the original Apex vehicle family in Blender 4.5+.

Run with Blender: blender -b --python tools/build_cars.py
Or with Blender's official Python module: python tools/build_cars.py
APEX_CAR_IDS=gt limits a design iteration; APEX_RENDER=1 renders studio previews.
All dimensions are metres. Helpers accept the game's x / height / forward frame.
"""
import bpy, bmesh, math, os, json
from pathlib import Path
from mathutils import Vector
from math import sin, cos, pi, sqrt
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/cars/custom'
OUT.mkdir(parents=True, exist_ok=True)
BLEND = ROOT / 'art/vehicles'
BLEND.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)

def xyz(p): return (p[0], -p[2], p[1])
def mix(a,b,t): return a+(b-a)*t
def smooth(t): return t*t*(3-2*t)
def raised(p): return (p[0]*1.004,p[1]+.003,p[2])
def lerp(a,b,t): return tuple(mix(x,y,t) for x,y in zip(a,b))
def profile(keys,z):
    if z<=keys[0][0]: return keys[0][1]
    for (a,va),(b,vb) in zip(keys,keys[1:]):
        if z<=b: return mix(va,vb,smooth((z-a)/(b-a)))
    return keys[-1][1]

def material(name,col,metal=0,rough=.4,coat=0,alpha=1,emit=0):
    m=bpy.data.materials.new(name);m.diffuse_color=(*col,alpha);m.use_nodes=True
    p=m.node_tree.nodes.get('Principled BSDF')
    for k,v in {'Base Color':(*col,1),'Metallic':metal,'Roughness':rough,'Coat Weight':coat,'Coat Roughness':.13,'Alpha':alpha,'Emission Color':(*col,1),'Emission Strength':emit}.items(): p.inputs[k].default_value=v
    if alpha<1:m.surface_render_method='DITHERED'
    if 'glass' in name.lower():
        p.inputs['Transmission Weight'].default_value=1
        p.inputs['Alpha'].default_value=1
        p.inputs['Base Color'].default_value=(.27,.38,.43,1)
        p.inputs['Roughness'].default_value=.07
    return m
M={
    'black':material('Satin graphite',(.010,.012,.015),.15,.42),
    'seam':material('Panel gap shadow',(.001,.0015,.002),0,.9),
    'rubber':material('Tire rubber',(.018,.020,.023),0,.84),
    'alloy':material('Machined aluminum',(.62,.68,.74),.85,.23),
    'darkalloy':material('Graphite alloy',(.075,.09,.11),.8,.28),
    'disc':material('Brake rotor steel',(.3,.33,.35),.8,.48),
    'caliper':material('Brake caliper vermilion',(.66,.025,.008),.25,.32),
    'glass':material('Smoked laminated glass',(.055,.105,.13),.15,.09,.65,.80),
    'leather':material('Interior charcoal leather',(.025,.031,.036),0,.76),
    'head':material('LED headlight phosphor',(.8,.91,1),.1,.18,0,1,1.8),
    'tail':material('LED taillight ruby',(.55,.009,.015),.15,.20,0,1,1.2),
    'amber':material('Amber reflector',(.95,.25,.015),.12,.26),
}
COLLECTION=None

def link(obj):
    for c in list(obj.users_collection):c.objects.unlink(obj)
    COLLECTION.objects.link(obj)
    return obj

def mesh(name,verts,faces,mat,smooth_shade=True):
    me=bpy.data.meshes.new(name);me.from_pydata([xyz(v) for v in verts],[],faces);me.update()
    bm=bmesh.new();bm.from_mesh(me);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bm.to_mesh(me);bm.free()
    ob=bpy.data.objects.new(name,me);COLLECTION.objects.link(ob);ob.data.materials.append(mat)
    for p in me.polygons:p.use_smooth=smooth_shade
    return ob

def apply(ob,mod):
    bpy.context.view_layer.objects.active=ob
    bpy.ops.object.modifier_apply(modifier=mod.name)

def bevel(ob,r=.02,segments=3):
    m=ob.modifiers.new('Manufactured edge radii','BEVEL');m.width=r;m.segments=segments
    apply(ob,m)
    m=ob.modifiers.new('Weighted corner normals','WEIGHTED_NORMAL');m.keep_sharp=True;apply(ob,m)
    return ob

def box(name,p,size,mat,r=.015):
    bpy.ops.mesh.primitive_cube_add(size=1,location=xyz(p));ob=link(bpy.context.object);ob.name=name;ob.scale=(size[0],size[2],size[1])
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    ob.data.materials.append(mat)
    if r:bevel(ob,r)
    return ob

def tube(name,pts,r,mat,closed=False,sides=8):
    # Parallel-transport-ish local frames, with shared vertices along every tube.
    verts=[];faces=[];n=len(pts)
    for i,p in enumerate(pts):
        d=Vector(pts[(i+1)%n])-Vector(pts[(i-1)%n]) if closed or 0<i<n-1 else Vector(pts[min(n-1,i+1)])-Vector(pts[max(0,i-1)])
        d.normalize();u=d.cross(Vector((0,1,0)))
        if u.length<.01:u=d.cross(Vector((1,0,0)))
        u.normalize();v=d.cross(u).normalized()
        for j in range(sides):verts.append(tuple(Vector(p)+r*(cos(2*pi*j/sides)*u+sin(2*pi*j/sides)*v)))
    for i in range(n if closed else n-1):
        for j in range(sides):faces.append((i*sides+j,i*sides+(j+1)%sides,((i+1)%n)*sides+(j+1)%sides,((i+1)%n)*sides+j))
    if not closed:faces.extend([tuple(range(sides-1,-1,-1)),tuple((n-1)*sides+j for j in range(sides))])
    return mesh(name,verts,faces,mat)

def panel(name,fn,mat,nu=20,nv=12):
    verts=[fn(i/nu,j/nv) for j in range(nv+1) for i in range(nu+1)];faces=[]
    for j in range(nv):
        for i in range(nu):a=j*(nu+1)+i;faces.append((a,a+1,a+nu+2,a+nu+1))
    return mesh(name,verts,faces,mat)

def lathe_x(name,c,section,mat,steps=64):
    verts=[];faces=[]
    for x,r in section:
        for i in range(steps):a=2*pi*i/steps;verts.append((c[0]+x,c[1]+r*cos(a),c[2]+r*sin(a)))
    for j in range(len(section)-1):
        for i in range(steps):a=j*steps+i;b=j*steps+(i+1)%steps;faces.append((a,b,b+steps,a+steps))
    return mesh(name,verts,faces,mat)

def cylinder_x(name,c,r,width,mat,steps=48):return lathe_x(name,c,[(-width/2,0),(-width/2,r),(width/2,r),(width/2,0)],mat,steps)

def parent_to(ob,parent):ob.parent=parent

DESIGNS=json.loads((ROOT/'assets/cars/designs.json').read_text())

def build(d):
    global COLLECTION
    COLLECTION=bpy.data.collections.new(d['name']);bpy.context.scene.collection.children.link(COLLECTION)
    root=bpy.data.objects.new(d['name']+' assembly',None);COLLECTION.objects.link(root)
    L,W,R,B,H=d['L'],d['W'],d['R'],d['belt'],d['H'];end=L/2;half=W/2
    paint=material('paint '+d['id'],d['color'],.28,.29,1)
    rear,front=d['axles'];low=.26 if not d.get('suv') else .36
    heights=[(-end,B-.20),(-end+.16,B-.055),(-end+.6,B),(-.7,B+.02),(.35,B),(.85,B-.025),(front,B-.09),(end-.18,B-.19),(end,B-.28)]
    def top(z):return profile(heights,z)
    def width(z):
        t=abs(z)/end
        return half*(1-.18*t**8)+.015*math.exp(-((z-rear)/.4)**2)+.009*math.exp(-((z-front)/.4)**2)
    def side_x(y,z):
        mid=(top(z)+low)/2;h=(top(z)-low)/2
        t=min(.999,abs((y-mid)/h))
        return width(z)*max(.001,1-t**(2/.45))**(.4/2)
    # Continuous quad skin; circular arches are cut from the actual volume.
    verts=[];faces=[];nz=112;nc=48
    for i in range(nz+1):
        z=mix(-end,end,i/nz);mid=(top(z)+low)/2;h=(top(z)-low)/2
        for j in range(nc):
            a=2*pi*j/nc;x=width(z)*math.copysign(abs(sin(a))**.4,sin(a));y=mid+h*math.copysign(abs(cos(a))**.45,cos(a))
            verts.append((x,y,z))
    for i in range(nz):
        for j in range(nc):faces.append((i*nc+j,i*nc+(j+1)%nc,(i+1)*nc+(j+1)%nc,(i+1)*nc+j))
    faces.extend([tuple(range(nc-1,-1,-1)),tuple(nz*nc+j for j in range(nc))])
    skin=mesh('Sculpted body shell',verts,faces,paint)
    for z in [rear,front]:
        cut=cylinder_x('Arch cutting tool',(0,R,z),R+.065,3.2,M['black'],96)
        mod=skin.modifiers.new('Open wheel arch','BOOLEAN');mod.operation='DIFFERENCE';mod.object=cut;mod.solver='EXACT';apply(skin,mod)
        bpy.data.objects.remove(cut,do_unlink=True)
    # Mill an actual cabin opening. Without it the bonnet skin fills the interior
    # and appears as coloured glass even with physically correct transmission.
    rf,rr,bf,br,rw=d['rf'],d['rr'],d['bf'],d['br'],d['roofW']
    cut=box('Cabin cutting tool',(0,low+1.70,(bf+br)/2),(W*.73,3.0,bf-br-.12),M['black'],.04)
    mod=skin.modifiers.new('Open passenger cabin','BOOLEAN');mod.operation='DIFFERENCE';mod.object=cut;mod.solver='EXACT';apply(skin,mod)
    bpy.data.objects.remove(cut,do_unlink=True)
    # Transfer the original analytic surface normals through the arch booleans.
    # The boolean leaves skinny boundary triangles; area-weighted normals would dent the fender highlights.
    def field(x,y,z):
        mid=(top(z)+low)/2;h=(top(z)-low)/2
        return (abs(x)/width(z))**5+(abs(y-mid)/h)**(2/.45)-1
    normals=[]
    for poly in skin.data.polygons:
        for li in poly.loop_indices:
            v=skin.data.vertices[skin.data.loops[li].vertex_index].co;x,y,z=v.x,v.z,-v.y
            e=.0001;n=Vector(xyz(((field(x+e,y,z)-field(x-e,y,z))/(2*e),(field(x,y+e,z)-field(x,y-e,z))/(2*e),(field(x,y,z+e)-field(x,y,z-e))/(2*e))))
            n.normalize()
            normals.append(tuple(n if abs(field(x,y,z))<.01 and n.dot(poly.normal)>.35 else poly.normal))
    skin.data.normals_split_custom_set(normals)
    # Low bumpers, rocker blades, wheel-well linings.
    for s in [-1,1]:
        box('Rocker aero sill',(s*(half-.025),low+.035,(front+rear)/2),(.09,.08,front-rear-2*R),M['black'],.025)
        for z in [rear,front]:
            pts=[]
            for k in range(45):
                a=pi*k/44;yy=R+(R+.069)*sin(a);zz=z+(R+.069)*cos(a)
                pts.append((s*(side_x(yy,zz)+.009),yy,zz))
            tube('Rolled arch lip',pts,.012,paint)
            lathe_x('Dark inner arch liner',(s*(half-.15),R,z),[(-.07,R+.036),(.07,R+.036)],M['black'],64)
    for z in [-end,end]:box('Bumper splitter',(0,low+.035,z), (W*.79,.045,.12),M['black'],.032)
    # Roof with real glass surfaces and structural pillars.
    rf,rr,bf,br,rw=d['rf'],d['rr'],d['bf'],d['br'],d['roofW']
    def roof_width(z):return rw*(1-.035*((z-(rf+rr)/2)/max(.1,(rf-rr)/2))**2)
    def roof_y(z,u):return H+.033*(1-u*u)+.015*sin(pi*(z-rr)/(rf-rr))
    panel('Painted roof',lambda u,v:(roof_width(mix(rr,rf,v))*(2*u-1),roof_y(mix(rr,rf,v),2*u-1),mix(rr,rf,v)),paint,28,28)
    for label,zr,zb in [('Windshield',rf,bf),('Rear glass',rr,br)]:
        def surface(u,v,zr=zr,zb=zb):
            a=2*u-1;z=mix(zr,zb,v);w=mix(roof_width(zr),width(zb)*.9,v);y=mix(H,top(zb)+.014,v)+.034*(1-a*a)
            return (a*w,y,z+(.018 if zb>zr else -.018)*sin(pi*v)*(1-a*a))
        panel(label,surface,M['glass'],28,22)
        for s in [-1,1]:
            pts=[surface((s+1)/2,k/20) for k in range(21)]
            panel(label+' structural pillar',lambda u,v,s=s:raised(surface(mix(0,.052,u) if s<0 else mix(.948,1,u),v)),paint,3,22)
        tube(label+' bottom seal',[surface(k/24,1) for k in range(25)],.006,M['seam'])
    for s in [-1,1]:
        upperRear=(s*roof_width(rr),H,rr);upperFront=(s*roof_width(rf),H,rf)
        lowerRear=(s*width(br)*.9,top(br)+.013,br);lowerFront=(s*width(bf)*.9,top(bf)+.013,bf)
        def window(u,v):
            p=lerp(lerp(lowerRear,lowerFront,u),lerp(upperRear,upperFront,u),v)
            return (p[0]+s*.016*sin(pi*u)*sin(pi*v),p[1],p[2])
        panel('Side glass',window,M['glass'],36,16)
        for v in [0,1]:tube('Window surround',[window(k/36,v) for k in range(37)],.006,M['seam'])
        # Roof side painted rail sits above the seal.
        panel('Roof edge',lambda u,v:(s*roof_width(mix(rr,rf,v))*mix(.94,1.02,u),roof_y(mix(rr,rf,v),s*mix(.94,1.02,u)),mix(rr,rf,v)),paint,3,28)
        split=.48 if d['doors']==4 else .32
        panel('Gloss black B pillar',lambda u,v:raised(window(mix(split-.028,split+.028,u),v)),M['black'],3,14)
        # Door shut lines, defined on the actual curved skin rather than a texture.
        doorRear=max(br+.16,rear+.25);doorFront=bf-.08;doorBottom=low+.13
        splits=[doorRear, mix(doorRear,doorFront,.48),doorFront] if d['doors']==4 else [doorRear,doorFront]
        for za,zb in zip(splits,splits[1:]):
            yy=min(top(za),top(zb))-.085;path=[]
            for i in range(10):z=mix(za+.03,zb-.025,i/9);path.append((s*(side_x(doorBottom,z)+.005),doorBottom,z))
            for i in range(12):y=mix(doorBottom,yy,i/11);path.append((s*(side_x(y,zb-.025)+.005),y,zb-.025))
            for i in range(10):z=mix(zb-.025,za+.03,i/9);y=top(z)-.075;path.append((s*(side_x(y,z)+.005),y,z))
            for i in range(12):y=mix(top(za+.03)-.075,doorBottom,i/11);path.append((s*(side_x(y,za+.03)+.005),y,za+.03))
            tube('Door shut line',path,.0032,M['seam'],True,6)
            hz=za+.20;hy=top(hz)-.12
            box('Flush door handle',(s*(side_x(hy,hz)+.009),hy,hz),(.025,.035,.15),M['darkalloy'],.012)
        # Mirrors are a separate damage part with a reflective face.
        mp=(s*(half+.085),B+.075,bf-.17)
        tube('Mirror stalk',[(s*(half-.10),B+.04,bf-.17),mp],.023,M['black'])
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24,ring_count=12,location=xyz(mp));ob=link(bpy.context.object);ob.name='Mirror housing';ob.scale=(.12,.11,.048);ob.data.materials.append(paint)
        for face in ob.data.polygons:face.use_smooth=True
        box('Mirror reflective face',(mp[0],mp[1],mp[2]-.087),(.15,.063,.009),M['alloy'],.02)
    # Bonnet and boot seams, slight creases follow the body curvature.
    for z0,z1,w in [(bf+.07,end-.23,.57),(-end+.19,br-.06,.60)]:
        if z1<=z0:continue
        pts=[]
        for x,z in [(mix(a[0],b[0],i/16),mix(a[1],b[1],i/16)) for a,b in zip([(-w,z0),(w,z0),(w,z1),(-w,z1)],[ (w,z0),(w,z1),(-w,z1),(-w,z0)]) for i in range(16)]:
            # Get the upper superellipse height at this x.
            t=abs(x)/width(z);y=(top(z)+low)/2+(top(z)-low)/2*max(0,1-t**(2/.4))**(.45/2)
            pts.append((x,y+.006,z))
        tube('Bonnet panel gap',pts,.0032,M['seam'],True,6)
    # Grilles, inset projector lamps and separate DRLs.
    for frontEnd in [True,False]:
        s=1 if frontEnd else -1;z=s*(end+.003);y=top(s*end)-.10
        box('Front grille housing' if frontEnd else 'Rear diffuser grille',(0,low+.19,z),(W*(.67 if d.get('muscle') else .49),.205,.018),M['black'],.047)
        for k in range(13):box('Grille vertical fin',((k-6)*W*.033,low+.19,z+s*.013),(.007,.145,.014),M['darkalloy'],.005)
        if d.get('muscle') or d['id']=='gt':
            for j in range(3):box('Grille horizontal blade',(0,low+.13+j*.06,z+s*.017),(W*.48,.008,.018),M['darkalloy'],.003)
        for side in [-1,1]:
            x=side*W*.31
            box('Lamp recessed housing',(x,y,z),(.40,.091,.025),M['black'],.034)
            lamp=M['head'] if frontEnd else M['tail'];label='Headlight' if frontEnd else 'Taillight'
            # Three thin optical strips retain a recognizable light signature at distance.
            for k in range(2):
                box(label+' LED blade',(x,y+.022-k*.044,z+s*.017),(.32,.018,.012),lamp,.008)
            box('Amber side marker',(side*W*.40,y,z+s*.017),(.022,.036,.01),M['amber'],.006)
        if not frontEnd:
            box('Rear number plate',(0,low+.16,z+.045),(.36,.105,.018),M['black'],.014)
            for side in [-1,1]:
                # Open tailpipe barrel, visible inner cavity.
                pts=[(side*W*.32+.049*cos(2*pi*k/32),low+.06+.035*sin(2*pi*k/32),z-.035) for k in range(32)]
                tube('Exhaust rolled tip',pts,.009,M['alloy'],True)
        else:
            box('Nose badge',(0,y+.075,z+.020),(.058,.024,.009),M['alloy'],.008)
    # Dark cabin shell, seats, dash and steering wheel are modeled through the glass.
    box('Interior cabin floor',(0,low+.21,(bf+br)/2),(W*.71,.10,bf-br-.13),M['leather'],.045)
    for s in [-1,1]:box('Interior door card',(s*W*.35,(low+B)/2,(bf+br)/2),(.055,B-low-.15,bf-br-.18),M['leather'],.025)
    box('Interior dashboard',(0,B-.03,bf-.13),(W*.72,.16,.24),M['leather'],.06)
    for z in [0.10,-.66] if d['doors']==4 else [-.12]:
        for s in [-1,1]:
            x=s*.37
            box('Interior seat cushion',(x,B-.22,z),(.48,.15,.48),M['leather'],.065)
            seat=box('Interior seat back',(x,(B+H)/2-.1,z-.23),(.47,H-B+.14,.14),M['leather'],.068)
            box('Interior headrest',(x,H-.12,z-.23),(.26,.17,.14),M['leather'],.054)
    box('Interior centre console',(0,B-.15,0),(.18,.25,.74),M['black'],.028)
    steering=[(.35+.16*cos(2*pi*k/40),B+.04+.16*sin(2*pi*k/40),bf-.29) for k in range(40)]
    tube('Interior steering wheel',steering,.018,M['leather'],True)
    for a in [pi/6,5*pi/6,3*pi/2]:
        tube('Interior steering spoke',[(.35,B+.04,bf-.29),(.35+.14*cos(a),B+.04+.14*sin(a),bf-.29)],.018,M['darkalloy'])
    box('Interior steering hub',(.35,B+.04,bf-.295),(.07,.075,.036),M['leather'],.016)
    tube('Interior steering column',[(.35,B+.04,bf-.29),(.35,B-.02,bf-.08)],.025,M['black'])
    box('Interior instrument binnacle',(.35,B+.02,bf-.12),(.40,.12,.11),M['black'],.035)
    box('Interior centre display',(-.05,B+.008,bf-.265),(.20,.085,.008),M['glass'],.012)
    # Fine dashboard vents and wipers sit close to the windscreen base.
    for s in [-1,1]:
        box('Interior vent',(s*.64,B+.025,bf-.26),(.13,.025,.02),M['black'],.005)
        pts=[(s*mix(.10,.57,k/12),top(bf)+.028+.015*sin(pi*k/12),bf-.015-.05*sin(pi*k/12)) for k in range(13)]
        tube('Wiper',pts,.007,M['black'],False,6)
    if d.get('wing'):
        for s in [-1,1]:box('Spoiler upright',(s*.57,top(-end+.33)+.10,-end+.31),(.025,.19,.16),M['black'],.01)
        box('Rear aero wing',(0,top(-end+.33)+.19,-end+.31),(W*.88,.040,.24),M['darkalloy'],.019)
    if d.get('suv'):
        for s in [-1,1]:tube('Roof luggage rail',[(s*.66,H+.055,mix(rr+.08,rf-.1,k/20)) for k in range(21)],.022,M['darkalloy'])
    if d.get('supercar'):
        for s in [-1,1]:
            mesh('Side intake',[(s*(side_x(y,z)+.012),y,z) for y,z in [(B-.32,-1.0),(B-.12,-.91),(B-.14,-.49),(B-.29,-.61)]],[(0,1,2,3)],M['black'],False)
    # Individually riggable wheels. Everything below a wheel root follows its axle;
    # the game detects brake calipers and keeps them out of the spinning assembly.
    for axle,z in [('rear',rear),('front',front)]:
        for s in [-1,1]:
            wx=s*(half-.075);c=(wx,R,z);wheel=bpy.data.objects.new('wheel_'+axle+('_left' if s>0 else '_right'),None);COLLECTION.objects.link(wheel);wheel.parent=root
            before=set(COLLECTION.objects)
            tw=.255 if not d.get('supercar') else (.31 if axle=='rear' else .275)
            section=[(-tw/2,R*.69),(-tw/2-.005,R*.84),(-tw*.44,R*.95),(-tw*.30,R*.995),(0,R),(tw*.30,R*.995),(tw*.44,R*.95),(tw/2+.005,R*.84),(tw/2,R*.69)]
            lathe_x('Tire',c,section,M['rubber'],80)
            # Circumferential rain channels and shoulder details.
            for off in [-.066,0,.066]:
                lathe_x('Tire tread channel',c,[(off-.002,R+.0006),(off+.002,R+.0006)],M['black'],80)
            outer=s*(tw/2+.006);rrim=R*.71
            lathe_x('Wheel rim barrel',c,[(-tw/2,rrim),(-tw/2,rrim-.018),(tw/2,rrim-.018),(tw/2,rrim)],M['darkalloy'],64)
            lathe_x('Wheel polished lip',c,[(outer-s*.009,rrim-.01),(outer,rrim),(outer+s*.007,rrim-.006),(outer+s*.007,rrim-.022)],M['alloy'],64)
            discx=wx+s*.064
            cylinder_x('Brake disc',(discx,R,z),R*.58,.014,M['disc'],64)
            # Perforations read as holes against the dark interior.
            for k in range(24):
                a=2*pi*k/24;cylinder_x('Brake rotor drilled hole',(discx+s*.008,R+R*.47*cos(a),z+R*.47*sin(a)),.006,.001,M['black'],8)
            box('Brake caliper',(wx+s*.056,R+.025,z-R*.47),(.085,.15,.07),M['caliper'],.022)
            spokes=d['spokes']
            for k in range(spokes):
                a=2*pi*k/spokes;angle=.09 if spokes==10 else .15
                poly=[]
                for xx in [outer-s*.035,outer+s*.002]:
                    for radius,ang in [(R*.13,a-.11),(R*.67,a+angle-.055),(R*.67,a+angle+.055),(R*.13,a+.11)]:poly.append((wx+xx,R+radius*cos(ang),z+radius*sin(ang)))
                ob=mesh('Wheel forged spoke',poly,[(0,3,2,1),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],M['alloy']);bevel(ob,.004,2)
            cylinder_x('Wheel center cap',(wx+outer,R,z),.062,.022,M['darkalloy'],40)
            cylinder_x('Wheel hub medallion',(wx+outer+s*.014,R,z),.025,.004,M['alloy'],32)
            for k in range(5):
                a=2*pi*k/5;cylinder_x('Wheel lug bolt',(wx+outer+s*.013,R+.042*cos(a),z+.042*sin(a)),.008,.012,M['alloy'],6)
            for ob in set(COLLECTION.objects)-before:ob.parent=wheel
    # Keep authored material groups shared, and parents meaningful for rigging.
    for ob in COLLECTION.objects:
        if ob!=root and ob.parent is None:ob.parent=root
    bpy.ops.object.select_all(action='DESELECT')
    for ob in COLLECTION.objects:ob.select_set(True)
    bpy.context.view_layer.objects.active=root
    bpy.ops.export_scene.gltf(filepath=str(OUT/(d['id']+'.glb')),export_format='GLB',use_selection=True,export_apply=True,export_animations=False,export_extras=True)
    tris=sum(len(ob.data.polygons) for ob in COLLECTION.objects if ob.type=='MESH')
    print('BUILT',d['id'],len(COLLECTION.objects),'objects',tris,'faces',flush=True)
    return COLLECTION,root

# The manifest is derived from the same design data as the geometry.
kinds={'gt':'Grand tourer','sedan':'Sedan','hatchback':'Hatchback','suv':'Utility','coupe':'Muscle coupe','supercar':'Supercar'}
manifest=[dict(id=d['id'],name=d['name'],file='custom/'+d['id']+'.glb',length=d['L'],up='+y',forward='+z',authored=True,
    credit='Original Apex Flats vehicle; authored in Blender with tools/build_cars.py',source='art/vehicles/apex-vehicles.blend',
    base=d['base'],price=d['price'],level=d['level'],power=d['power'],massScale=d['massScale'],paint=d['color'],kind=kinds[d['base']],
    description=f"{d['L']:.2f} m {kinds[d['base']].lower()} · {d['doors']} doors · {d['spokes']}-spoke alloys") for d in DESIGNS]
(ROOT/'assets/cars/cars.json').write_text(json.dumps(manifest,indent=2)+'\n')

selected=os.environ.get('APEX_CAR_IDS','').split(',')
models=[d for d in DESIGNS if not selected[0] or d['id'] in selected]
assets=[(d,*build(d)) for d in models]
# Arrange editable source assemblies in a design studio.
COLLECTION=bpy.data.collections.new('Studio');bpy.context.scene.collection.children.link(COLLECTION)
floor=box('Studio floor',(0,-.10,0),(200,.16,200),material('Studio floor',(.075,.083,.095),.05,.48),0)
scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=32;scene.cycles.use_denoising=True
scene.world=bpy.data.worlds.new('Studio world');scene.world.use_nodes=True;scene.world.node_tree.nodes['Background'].inputs[0].default_value=(.22,.25,.31,1);scene.world.node_tree.nodes['Background'].inputs[1].default_value=.35
for name,pos,power,size in [('Key',(-3,6,3),1800,5),('Rim',(4,4,-2),2200,4),('Front',(1,3,6),1100,3)]:
    ld=bpy.data.lights.new(name,'AREA');ld.energy=power;ld.shape='DISK';ld.size=size;ob=bpy.data.objects.new(name,ld);COLLECTION.objects.link(ob);ob.location=xyz(pos);ob.rotation_euler=(Vector(xyz((0,.7,0)))-ob.location).to_track_quat('-Z','Y').to_euler()
camd=bpy.data.cameras.new('Design review camera');cam=bpy.data.objects.new('Design review camera',camd);COLLECTION.objects.link(cam);scene.camera=cam;cam.location=xyz((6.6,3.7,7.9));cam.rotation_euler=(Vector(xyz((0,.72,0)))-cam.location).to_track_quat('-Z','Y').to_euler();camd.lens=57
scene.render.resolution_x=1440;scene.render.resolution_y=960;scene.render.resolution_percentage=100
scene.view_settings.view_transform='AgX'
if os.environ.get('APEX_RENDER')=='1':
    for d,col,root in assets:
        for _,c,_ in assets:c.hide_render=c!=col
        scene.render.filepath=str(BLEND/(d['id']+'-studio.png'));bpy.ops.render.render(write_still=True)
for i,(d,col,root) in enumerate(assets):
    col.hide_render=False;root.location=xyz(((i%6)*3.6,0,-(i//6)*6))
# Source opens with every model separated on the floor.
if len(assets)>1:
    cam.location=xyz((26,25,26));cam.rotation_euler=(Vector(xyz((9,.6,-9)))-cam.location).to_track_quat('-Z','Y').to_euler();camd.lens=48
bpy.context.preferences.filepaths.save_version=0
bpy.ops.wm.save_as_mainfile(filepath=str(BLEND/'apex-vehicles.blend'),compress=True)
print('Saved editable Blender source.',flush=True)
