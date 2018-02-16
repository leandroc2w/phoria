
(function() {
   "use strict";

   Phoria.Scene = function()
   {
     
      this.camera = {
     
         up: {x:0.0, y:1.0, z:0.0},
     
         lookat: {x:0.0, y:0.0, z:0.0},
        
         position: {x:0.0, y:0.0, z:-10.0}
      };
      
      this.perspective = {
 
         fov: 35.0,
         
         aspect: 1.0,
       
         near: 1.0,
         
         far: 10000.0
      };
      
    
      this.viewport = {
         x: 0,
         y: 0,
         width: 1024,
         height: 1024
      };
      
      this.graph = [];
      this.triggerHandlers = [];

      return this;
   };

   Phoria.Scene.create = function(desc)
   {
      var s = new Phoria.Scene();
      if (desc.camera) s.camera = Phoria.Util.merge(s.camera, desc.camera);
      if (desc.perspective) s.perspective = Phoria.Util.merge(s.perspective, desc.perspective);
      if (desc.viewport) s.viewport = Phoria.Util.merge(s.viewport, desc.viewport);
      if (desc.graph) s.graph = desc.graph;
      if (desc.onCamera) s.onCamera(desc.onCamera);
      
      return s;
   };

   Phoria.Scene.prototype = {
  
      camera: null,
      
      perspective: null,
      
      graph: null,

      viewport: null,

      renderlist: null,

      lights: null,
      
      triggerHandlers: null,
      
      onCameraHandlers: null,

      _entities: null,

      _lastTime: 0,
      _cameraPosition: null,       
      _perspectiveScale: 0.0,


      findEntity: function findEntity(id)
      {
         return this._entities[id];
      },

     
      onCamera: function onCamera(fn)
      {
         if (this.onCameraHandlers === null) this.onCameraHandlers = [];
         this.onCameraHandlers = this.onCameraHandlers.concat(fn);
      },
      
      modelView: function modelView()
      {
       
         var now = Date.now(),
             time = (now - this._lastTime) / 1000;
         this._lastTime = now;
         
         var vpx = this.viewport.x,
             vpy = this.viewport.y,
             vpw = this.viewport.width * 0.5,
             vph = this.viewport.height * 0.5;
         
         this._cameraPosition = vec4.fromValues(
            this.camera.position.x,
            this.camera.position.y,
            this.camera.position.z,
            0);
         var camera = mat4.create(),
             cameraLookat = vec4.fromValues(
               this.camera.lookat.x,
               this.camera.lookat.y,
               this.camera.lookat.z,
               0),
             cameraUp = vec4.fromValues(
               this.camera.up.x,
               this.camera.up.y,
               this.camera.up.z,
               0);
         
         // hook point to allow processing of the camera vectors before they are applied to the lookAt matrix
         // e.g. rotate the camera position around an axis
         // another way to do this would be to perform this step manually at the start of an animation loop
         if (this.onCameraHandlers !== null)
         {
            for (var h=0; h<this.onCameraHandlers.length; h++)
            {
               this.onCameraHandlers[h].call(this, this._cameraPosition, cameraLookat, cameraUp);
            }
         }

         // generate the lookAt matrix
         mat4.lookAt(
            camera,
            this._cameraPosition,
            cameraLookat,
            cameraUp);
         
         // calculate perspective matrix for our scene
         var perspective = mat4.create();
         mat4.perspective(
            perspective,
            -this.perspective.fov * Phoria.RADIANS,
            this.perspective.aspect,
            this.perspective.near,
            this.perspective.far);
         // scaling factor used when rendering points to account for perspective fov
         this._perspectiveScale = (256 - this.perspective.fov) / 16;
         
         // process each object in the scene graph
         // and recursively process each child entity (against parent local matrix)
         var renderlist = [],
             lights = [],
             entityById = {};
         
         // recursive processing function - keeps track of current matrix operation
         var fnProcessEntities = function processEntities(entities, matParent)
         {
            for (var n=0, obj, len, isIdentity; n<entities.length; n++)
            {
               obj = entities[n];

               // check disabled flag for this entity
               if (obj.disabled) continue;

               // construct entity lookup list by optional ID
               // used to quickly lookup entities in event handlers without walking child lists etc.
               if (obj.id) entityById[obj.id] = obj;
               
               // hook point for onBeforeScene event handlers - custom user handlers or added by entities during
               // object construction - there can be multiple registered per entity
               if (obj.onBeforeSceneHandlers !== null)
               {
                  for (var h=0; h<obj.onBeforeSceneHandlers.length; h++)
                  {
                     obj.onBeforeSceneHandlers[h].call(obj, this, time);
                  }
               }

               // multiply local with parent matrix to combine affine transformations
               var matLocal = obj.matrix;
               if (matParent)
               {
                  // if parent matrix is provided multiply it against local matrix else use the parent matrix
                  matLocal = matLocal ? mat4.multiply(mat4.create(), matLocal, matParent) : matParent;
               }
               
               // hook point for onScene event handlers - custom user handlers or added by entities during
               // object construction - there can be multiple registered per entity
               if (obj.onSceneHandlers !== null)
               {
                  for (var h=0; h<obj.onSceneHandlers.length; h++)
                  {
                     obj.onSceneHandlers[h].call(obj, this, matLocal, time);
                  }
               }
               
               if (obj instanceof Phoria.BaseLight)
               {
                  lights.push(obj);
               }
               else if (obj instanceof Phoria.Entity)
               {
                  len = obj.points.length;
                  
                  // pre-create or reuse coordinate buffers for world, screen, normal and clip coordinates
                  obj.initCoordinateBuffers();
                  
                  // set-up some values used during clipping calculations
                  var objClip = 0,
                      clipOffset = 0;
                  if (obj.style.drawmode === "point")
                  {
                     // adjust vec by style linewidth calculation for linewidth scaled points or sprite points
                     // this allows large sprite/rendered points to avoid being clipped too early
                     if (obj.style.linescale === 0)
                     {
                        clipOffset = obj.style.linewidth * 0.5;
                     }
                     else
                     {
                        clipOffset = (obj.style.linewidth * obj.style.linescale) / this._perspectiveScale * 0.5;
                     }
                  }
                  
                  // main vertex processing loop
                  for (var v=0, verts, vec, w, avz=0; v<len; v++)
                  {
                     // construct homogeneous coordinate for the vertex as a vec4
                     verts = obj.points[v];
                     vec = vec4.set(obj._worldcoords[v], verts.x, verts.y, verts.z, 1.0);
                     
                     // local object transformation -> world space
                     // skip local transform if matrix not present
                     // else store locally transformed vec4 world points
                     if (matLocal) vec4.transformMat4(obj._worldcoords[v], vec, matLocal);
                     
                     // multiply by camera matrix to generate camera space coords
                     vec4.transformMat4(obj._cameracoords[v], obj._worldcoords[v], camera);
                     
                     // multiply by perspective matrix to generate perspective and clip coordinates
                     vec4.transformMat4(obj._coords[v], obj._cameracoords[v], perspective);
                     
                     // perspective division to create vec2 NDC then finally transform to viewport
                     // clip calculation occurs before the viewport transform
                     vec = obj._coords[v];
                     w = vec[3];
                     
                     // stop divide by zero
                     if (w === 0) w = Phoria.EPSILON;
                     
                     // is this vertex outside the clipping boundries for the perspective frustum?
                     objClip += (obj._clip[v] = (vec[0] > w+clipOffset || vec[0] < -w-clipOffset ||
                                                 vec[1] > w+clipOffset || vec[1] < -w-clipOffset ||
                                                 vec[2] > w || vec[2] < -w) ? 1 : 0);
                     
                     // perspective division
                     vec[0] /= w;
                     vec[1] /= w;
                     // Z is used by coarse object depth sort
                     
                     // linear transform to viewport - could combine with division above - but for clarity it is not
                     vec[0] = vpw * vec[0] + vpx + vpw;
                     vec[1] = vph * vec[1] + vpy + vph;
                     
                     // keep track of average Z here as it's no overhead and it's useful for rendering
                     avz += vec[2];
                  }
                  // store average Z coordinate
                  obj._averagez = len > 1 ? avz/len : avz;
                  
                  // if entire object is clipped, do not bother with final steps or adding to render list
                  if (objClip !== len)
                  {
                     // sort the geometry before any further transformations
                     switch (obj.style.geometrysortmode)
                     {
                        default:
                        case "automatic":
                        case "sorted":
                        {
                           // solid objects always need sorting as each poly can be a different shade/texture
                           // wireframe and points objects will not be sorted if the "plain" shademode is used
                           if (obj.style.geometrysortmode === "sorted" ||
                               obj.style.drawmode === "solid" || obj.style.shademode === "lightsource")
                           {
                              switch (obj.style.drawmode)
                              {
                                 case "solid":
                                    Phoria.Util.sortPolygons(obj.polygons, obj._cameracoords);
                                    break;
                                 case "wireframe":
                                    Phoria.Util.sortEdges(obj.edges, obj._cameracoords);
                                    break;
                                 case "point":
                                    Phoria.Util.sortPoints(obj._coords, obj._worldcoords);
                                    break;
                              }
                           }
                           break;
                        }
                     }

                     // normal lighting transformation
                     if (obj.style.drawmode === "solid" && obj.polygons.length !== 0)
                     {
                        // TODO: have a flag on scene for "transposedNormalMatrix..." - i.e. make it optional?
                        // invert and transpose the local model matrix - for correct normal scaling
                        var matNormals = mat4.invert(mat4.create(), matLocal ? matLocal : mat4.create());
                        mat4.transpose(matNormals, matNormals);
                        
                        switch (obj.style.shademode)
                        {
                           case "lightsource":
                           {
                              // transform each polygon normal
                              for (var i=0, normal, wnormal; i<obj.polygons.length; i++)
                              {
                                 if (!obj.polygons[i]._worldnormal) obj.polygons[i]._worldnormal = vec4.create();
                                 
                                 // normal transformation -> world space
                                 normal = obj.polygons[i].normal;
                                 wnormal = obj.polygons[i]._worldnormal;
                                 // use vec3 to ensure normal directional component is not modified
                                 vec3.transformMat4(wnormal, normal, matNormals);
                                 vec3.normalize(wnormal, wnormal);
                              }
                              break;
                           }
                           /*
                           case "gouraud":
                           {
                              // transform each vertex normal
                              for (var i=0, normal, wnormal; i<len; i++)
                              {
                                 normal = obj._vertexNormals[i];
                                 wnormal = obj._worldVertexNormals[i];
                                 vec4.transformMat4(wnormal, normal, matNormals);
                                 vec4.normalize(wnormal, wnormal);
                              }
                              break;
                           }
                           */
                        }
                     }
                     
                     // add to the flattened render list
                     renderlist.push(obj);
                  }
               } // end entity processing
               
               // recursively process children
               if (obj.children && obj.children.length !== 0)
               {
                  fnProcessEntities.call(this, obj.children, matLocal);
               }
               
            } // end entity list loop
         };
         fnProcessEntities.call(this, this.graph, null);

         // set the public references to the flattened list of objects to render and the list of lights
         this.renderlist = renderlist;
         this.lights = lights;
         this._entities = entityById;

         // Process the scene trigger functions - this allows for real-time modification of the scene
         // based on a supplied handler function - a sequence of these triggers can nest and add new
         // triggers causing a sequence of events to perform chained actions to the scene as it executes.
         // Uses a for(...) loop to allow add/remove mods to the list during event processing.
         for (var t=0, len = this.triggerHandlers.length; t<len; t++)
         {
            // trigger handlers return true if they are finished i.e. no longer needed in the scene
            if (this.triggerHandlers[t].trigger.call(this, this._cameraPosition, cameraLookat, cameraUp))
            {
               this.triggerHandlers.splice(t, 1);
               len--;
            }
         }
      }
   };
})();
