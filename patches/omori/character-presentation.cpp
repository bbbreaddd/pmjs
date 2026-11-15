#include "character-presentation.hpp"
#include "../../src/mv_bound_sprites.hpp"
#include "../../src/mv_core_utils.hpp"

#include <algorithm>
#include <cmath>
#include <unordered_set>
#include <unordered_map>

namespace pmjs::mv::omori {
namespace {
double number(const Value& value) { return core::numberValue(value); }
bool truth(const Value& value) { return value.boolean(); }
bool different(const Value& left,const Value& right) {
  if(left.null() && right.null())return false;
  if(std::holds_alternative<std::string>(left.data) && std::holds_alternative<std::string>(right.data))return left.text()!=right.text();
  return number(left)!=number(right);
}
bool emptyText(const Value& value) { return std::holds_alternative<std::string>(value.data) && value.text().empty(); }
Value::Array argument(Value value) {Value::Array result;result.push_back(std::move(value));return result;}
Value invoke(CharacterPresentationContext& c,const std::string& name,const Value::Array& arguments={}) {
  return c.call(c.receiver,name,arguments);
}
Value character(CharacterPresentationContext& c) { return c.characterData(); }
Value onCharacter(CharacterPresentationContext& c,const std::string& name,const Value::Array& arguments={}) {
  return c.call(character(c),name,arguments);
}
std::shared_ptr<core::Sprite> sprite(CharacterPresentationContext& c,const Value& value) {
  auto result=std::dynamic_pointer_cast<core::Sprite>(c.displayOf(value));
  if(!result)throw std::runtime_error("character presentation requires a sprite");
  return result;
}
core::Sprite& selfSprite(CharacterPresentationContext& c) {
  auto* result=dynamic_cast<core::Sprite*>(c.display.get());
  if(!result)throw std::runtime_error("character presentation receiver is not a sprite");
  return *result;
}
std::shared_ptr<core::Container> spriteset(CharacterPresentationContext& c) {
  const auto& scene=c.environment["scene"];
  return scene["_spriteset"].null() ? nullptr : c.displayOf(scene["_spriteset"]);
}
}

CharacterPresentationQuery findCharacterPresentationQuery(const std::string& operation) {
  static const std::unordered_map<std::string,CharacterPresentationQuery> queries{
    {"map.tileWidth",[](Session& session,const Value::Array&) -> Value {return session.tileWidth();}},
    {"map.tileHeight",[](Session& session,const Value::Array&) -> Value {return session.tileHeight();}},
    {"map.adjustX",[](Session& session,const Value::Array& args) {return session.invokeGameDataBase("map","adjustX",args);}},
    {"map.adjustY",[](Session& session,const Value::Array& args) {return session.invokeGameDataBase("map","adjustY",args);}},
    {"map.width",[](Session& session,const Value::Array& args) {return session.invokeGameDataBase("map","width",args);}},
    {"map.height",[](Session& session,const Value::Array& args) {return session.invokeGameDataBase("map","height",args);}},
    {"map.displayX",[](Session& session,const Value::Array& args) {return session.invokeGameDataBase("map","displayX",args);}},
    {"map.displayY",[](Session& session,const Value::Array& args) {return session.invokeGameDataBase("map","displayY",args);}},
    {"map.isLoopHorizontal",[](Session& session,const Value::Array& args) {return session.invokeGameDataBase("map","isLoopHorizontal",args);}},
    {"map.isLoopVertical",[](Session& session,const Value::Array& args) {return session.invokeGameDataBase("map","isLoopVertical",args);}}
  };
  const auto found=queries.find(operation);return found==queries.end() ? nullptr : found->second;
}

bool hasCharacterPresentationOperation(const std::string& operation) {
  if(findCharacterPresentationQuery(operation))return true;
  static const std::unordered_set<std::string> operations{
    "label.chain", "icons.chain", "omori.chain", "reflection.chain", "omori.frame", "core.halfBodies",
    "frame.blockX", "frame.blockY", "frame.patternX", "frame.patternY", "frame.width", "frame.height", "frames.width",
    "omori.bobble", "omori.input", "omori.shadow", "label.update", "label.setup", "label.delay", "label.position", "label.zoom", "label.refresh",
    "icons.setup", "icons.start", "icons.update", "icons.end", "icons.playing", "icons.animation",
    "eventcon.update", "eventcon.frame", "input.update", "input.animation",
    "eventcon.speed", "eventcon.wait", "eventcon.index", "input.frame", "input.reset", "input.activate",
    "label.bufferX", "label.bufferY", "label.windowUpdate", "label.page", "label.opacity", "label.show", "label.hide", "label.allowed", "label.range", "label.facing",
    "character.singleFrame", "character.emf", "character.emfState", "character.eventId", "character.eventImage",
    "character.eventStart", "character.eventEnd", "character.eventPlaying",
    "character.object", "character.jump", "character.shift", "character.scrolledX", "character.scrolledY", "character.screenZ",
    "position.fukuX", "position.fukuY", "position.offsetX", "position.offsetY", "character.offsetX", "character.offsetY", "character.offsetInit",
    "map.screenTileX", "map.screenTileY",
    "map.yepAdjustX", "map.yepAdjustY", "map.scaledDisplayX", "map.scaledDisplayY"
  };
  return operations.contains(operation);
}

Value invokeCharacterPresentation(const std::string& operation,CharacterPresentationContext& c,const Value::Array& arguments) {
  const auto done=Value::undefined();
  if(operation=="map.screenTileX" || operation=="map.screenTileY") {
    const bool x=operation=="map.screenTileX";
    const double size=number(c.environment[x ? "screenWidth" : "screenHeight"]);
    return size/number(invoke(c,x ? "tileWidth" : "tileHeight"));
  }
  if(operation=="map.scaledDisplayX" || operation=="map.scaledDisplayY") {
    const bool x=operation=="map.scaledDisplayX";
    const double raw=number(c.receiver[x ? "_displayX" : "_displayY"]);
    const auto map=c.environment["map"].reference();const auto method=x ? "tileWidth" : "tileHeight";
    const double scaled=raw*number(c.call(map,method,{}));
    return scaled/number(c.call(map,method,{}));
  }
  if(operation=="map.yepAdjustX" || operation=="map.yepAdjustY") {
    const bool x=operation=="map.yepAdjustX";const auto display=x ? "displayX" : "displayY";
    const double coordinate=number(arguments.at(0));bool wrapped=false;
    if(truth(invoke(c,x ? "isLoopHorizontal" : "isLoopVertical"))) {
      const double offset=number(invoke(c,display));
      const double size=number(invoke(c,x ? "width" : "height"));
      const double visible=number(invoke(c,x ? "screenTileX" : "screenTileY"));
      wrapped=coordinate<offset-(size-visible)/2;
    }
    const double adjusted=coordinate-number(invoke(c,display));
    return wrapped ? adjusted+number(c.environment["mapData"][x ? "width" : "height"]) : adjusted;
  }
  if(operation=="character.object" || operation=="character.jump" || operation=="character.screenZ") {
    if(!c.entity)throw std::runtime_error("character geometry requires a native character");
    return c.session.runtimeCharacterCommand(c.entity,operation=="character.object" ? "isObjectCharacter" : operation=="character.jump" ? "jumpHeight" : "screenZ",{});
  }
  if(operation=="character.shift")return truth(invoke(c,"isObjectCharacter")) ? 0 : 6;
  if(operation=="character.scrolledX" || operation=="character.scrolledY")return c.call(c.environment["map"],operation=="character.scrolledX" ? "adjustX" : "adjustY",argument(c.receiver[operation=="character.scrolledX" ? "_realX" : "_realY"].reference()));
  if(operation=="position.fukuX") {
    const double width=number(c.call(c.environment["map"],"tileWidth",{}));return std::ceil(number(invoke(c,"scrolledX"))*width+width/2);
  }
  if(operation=="position.fukuY") {
    const double height=number(c.call(c.environment["map"],"tileHeight",{}));return std::ceil(number(invoke(c,"scrolledY"))*height+height-number(invoke(c,"shiftY"))-number(invoke(c,"jumpHeight")));
  }
  if(operation=="position.offsetX" || operation=="position.offsetY")return std::floor(number(c.base(arguments))+number(invoke(c,operation=="position.offsetX" ? "spriteOffsetX" : "spriteOffsetY"))+0.5);
  if(operation=="character.offsetInit") {c.set(c.receiver,"_spriteOffsetX",0);c.set(c.receiver,"_spriteOffsetY",0);return done;}
  if(operation=="character.offsetX" || operation=="character.offsetY") {
    const auto field=operation=="character.offsetX" ? "_spriteOffsetX" : "_spriteOffsetY";
    if(c.receiver[field].isUndefined())invoke(c,"initSpriteOffsets");return c.receiver[field].reference();
  }
  if(operation=="label.chain") { c.base(arguments);invoke(c,"updateMiniLabel");invoke(c,"updateMiniLabelZoom");return done; }
  if(operation=="icons.chain") { c.base(arguments);invoke(c,"updateEventcon");return done; }
  if(operation=="omori.chain") { c.base(arguments);invoke(c,"updateBobble");invoke(c,"updateInputIcon");invoke(c,"updateShadow");return done; }
  if(operation=="reflection.chain") { c.base(arguments);invoke(c,"updateReflect");return done; }
  if(operation=="character.singleFrame")return c.receiver["_singleFrame"].reference();
  if(operation=="character.emf")return c.receiver["_isEmfCharacter"].reference();
  if(operation=="character.emfState")return c.receiver["_emfCharacterState"].reference();
  if(operation=="character.eventId")return c.receiver["_eventIndex"].reference();
  if(operation=="character.eventImage")return c.receiver["_eventImg"].reference();
  if(operation=="character.eventStart" || operation=="character.eventEnd") {
    c.set(c.receiver,"_eventconPlaying",operation=="character.eventStart");return done;
  }
  if(operation=="character.eventPlaying")return number(c.receiver["_eventIndex"])>0 ? Value(true) : c.receiver["_eventconPlaying"].reference();
  if(operation=="label.bufferX" || operation=="label.bufferY") {
    const auto value=c.receiver[operation=="label.bufferX" ? "_bufferX" : "_bufferY"].reference();
    return value.isUndefined() ? c.environment["labelParameters"][operation=="label.bufferX" ? "EMWBufferX" : "EMWBufferY"].reference() : value;
  }
  if(operation=="label.windowUpdate") {
    c.base(arguments);const auto data=character(c);
    if(!truth(data) || !truth(data["_eventId"]))return done;
    invoke(c,"updatePage");if(!emptyText(c.receiver["_text"]))invoke(c,"updateOpacity");return done;
  }
  if(operation=="label.page") {
    const auto page=character(c)["_pageIndex"].reference();
    if(!different(c.receiver["_pageIndex"],page))return done;
    c.set(c.receiver,"_pageIndex",page);c.call(c.receiver["contents"],"clear",{});c.set(c.receiver,"_text","");invoke(c,"gatherDisplayData");return done;
  }
  if(operation=="label.opacity") { invoke(c,truth(invoke(c,"showMiniLabel")) ? "show" : "hide");return done; }
  if(operation=="label.show" || operation=="label.hide") {
    const auto window=std::dynamic_pointer_cast<core::Window>(c.display);if(!window)throw std::runtime_error("mini label is not a window");
    if(operation=="label.show") {
      if(window->contentsOpacity<255) {window->contentsOpacity=std::clamp(window->contentsOpacity+16,0.0,255.0);window->visible=true;}
    } else if(window->contentsOpacity<=0)window->visible=false;
    else window->contentsOpacity=std::clamp(window->contentsOpacity-16,0.0,255.0);
    return done;
  }
  if(operation=="label.range") {
    const double range=number(c.receiver["_range"]);if(range>=500)return true;
    const auto player=c.environment["player"].reference(),data=character(c);
    return range>=std::abs(number(player["x"])-number(data["x"])) && range>=std::abs(number(player["y"])-number(data["y"]));
  }
  if(operation=="label.facing") {
    const auto data=character(c);if(!truth(data) || !truth(c.receiver["_reqFacing"]))return true;
    const auto player=c.environment["player"].reference();const int direction=c.call(player,"direction",{}).integer();
    const double x=number(player["x"]),y=number(player["y"]),ex=number(data["x"]),ey=number(data["y"]);
    switch(direction) {
      case 1:return x>=ex && y<=ey;case 2:return y<=ey;case 3:return x<=ex && y<=ey;
      case 4:return x>=ex;case 6:return x<=ex;case 7:return x>=ex && y>=ey;
      case 8:return y>=ey;case 9:return x<=ex && y>=ey;default:return true;
    }
  }
  if(operation=="label.allowed") {
    if(truth(c.receiver["_alwaysShow"]))return true;
    if(!truth(invoke(c,"withinRange")) || !truth(invoke(c,"meetsFacingRequirements")))return false;
    if(!truth(c.environment["labelParameters"]["EMWBatTran"]) && number(c.environment["scene"]["_encounterEffectDuration"])>0) {
      c.set(c.receiver,"contentsOpacity",0);return false;
    }
    return c.call(c.environment["system"],"isShowEventMiniLabel",{});
  }
  if(operation.starts_with("frame.")) {
    const auto data=character(c);
    const bool x=operation=="frame.blockX" || operation=="frame.patternX";
    const auto field=operation=="frame.width" ? "_customFrameWidth" : operation=="frame.height" ? "_customFrameHeight" : x ? "_customFrameX" : "_customFrameY";
    const auto value=data[field].reference();
    if(!value.null() || value.isUndefined()) {
      if(operation=="frame.patternX" || operation=="frame.patternY")return 0;
      return value;
    }
    return c.base(arguments);
  }
  if(operation=="frames.width") {
    const auto width=c.base(arguments);
    return truth(onCharacter(c,"isEmfCharacter")) ? Value(number(width)*3/number(onCharacter(c,"emfCharacterState")["frameNum"])) : width;
  }
  if(operation=="omori.frame") {
    if(truth(character(c)) && truth(onCharacter(c,"isSingleFrame"))) {
      auto& s=selfSprite(c);const auto bitmap=s.bitmap();
      if(!bitmap)throw std::runtime_error("single-frame character has no bitmap");
      s.setFrame(0,0,bitmap->width,bitmap->height);return done;
    }
    return c.base(arguments);
  }
  if(operation=="core.halfBodies") {
    c.base(arguments);
    auto* s=dynamic_cast<CharacterSprite*>(c.display.get());
    if(s && s->state.bushDepth>0) { s->upperBody->blendMode=s->blendMode;s->lowerBody->blendMode=s->blendMode; }
    return done;
  }
  if(operation=="omori.bobble") {
    const auto bobble=character(c)["_bobble"].reference();auto& s=selfSprite(c);
    s.anchor.y=truth(bobble) ? number(bobble["base"])+std::sin(core::Graphics::frameCount*number(bobble["speed"]))*number(bobble["amplitude"]) : 1;
    return done;
  }
  if(operation=="label.update") {
    invoke(c,"setupMiniLabel");if(truth(c.receiver["_miniLabel"]))invoke(c,"positionMiniLabel");return done;
  }
  if(operation=="label.delay") {
    const auto delay=c.receiver["_labelDelay"].reference();
    if(c.display->parent && delay.isUndefined()) {
      c.set(c.receiver,"_labelDelay",c.call(c.receiver["parent"],"getChildIndex",argument(c.receiver.reference())));
    }
    const auto current=c.receiver["_labelDelay"].reference();
    if(number(current)>0) { c.set(c.receiver,"_labelDelay",number(current)-1);return number(current); }
    return c.base(arguments);
  }
  if(operation=="label.setup") {
    const auto label=c.receiver["_miniLabel"].reference();
    if(truth(label)) {
      const auto window=c.displayOf(label);const auto text=label["_text"].reference();
      if(text.text()!="" || !std::holds_alternative<std::string>(text.data)) {
        if(!window->parent)c.call(c.environment["scene"]["_spriteset"],"addChild",argument(label.reference()));
      } else if(window->parent)c.call(label["parent"],"removeChild",argument(label.reference()));
      return done;
    }
    const auto target=spriteset(c);if(!target)return done;
    const auto created=c.construct("Window_EventMiniLabel",{});
    c.set(c.receiver,"_miniLabel",created);c.call(created,"setCharacter",argument(character(c)));
    if(!emptyText(created["_text"]))c.call(c.environment["scene"]["_spriteset"],"addChild",argument(created.reference()));
    return done;
  }
  if(operation=="label.position" || operation=="label.zoom") {
    const auto label=c.receiver["_miniLabel"].reference();if(!truth(label))return done;
    const auto window=std::dynamic_pointer_cast<core::Window>(c.displayOf(label));
    if(!window)throw std::runtime_error("mini label is not a window");
    if(!window->parent)return done;
    if(operation=="label.zoom") {
      const auto target=spriteset(c);if(!target)throw std::runtime_error("mini label has no spriteset");
      window->scale={1/target->scale.x,1/target->scale.y};return done;
    }
    auto& s=selfSprite(c);
    window->position.x=s.position.x-window->width*window->scale.x/2+number(c.call(label,"bufferX",{}));
    window->position.y=s.position.y-number(c.receiver["height"])-window->height*window->scale.y+number(c.call(label,"bufferY",{}))*window->scale.y;
    return done;
  }
  if(operation=="label.refresh") { const auto label=c.receiver["_miniLabel"].reference();if(truth(label))c.call(label,"forceRefresh",{});return done; }
  if(operation=="icons.playing")return truth(c.receiver["_eventconSprite"]);
  if(operation=="icons.animation") {
    c.base(arguments);if(!truth(invoke(c,"isEventconPlaying")))onCharacter(c,"endEventcon");return done;
  }
  if(operation=="icons.setup") {
    if(number(onCharacter(c,"eventconId"))>0) {
      invoke(c,"startEventcon");onCharacter(c,"startEventcon");
      if(!truth(c.receiver["currentEventcondId"]))c.set(c.receiver,"currentEventcondId",onCharacter(c,"eventconId"));
      if(!truth(c.receiver["currentEventcondImg"]))c.set(c.receiver,"currentEventcondImg",onCharacter(c,"eventconImg"));
    }
    return done;
  }
  if(operation=="icons.start") {
    const auto id=onCharacter(c,"eventconId"),image=onCharacter(c,"eventconImg");
    if(!truth(c.receiver["_eventconSprite"]) || different(c.receiver["currentEventcondId"],id) || different(c.receiver["currentEventcondImg"],image)) {
      invoke(c,"endEventcon");const auto icon=c.construct("Sprite_EventCon",{});
      c.set(c.receiver,"_eventconSprite",icon);c.call(icon,"setup",{image,id});c.call(c.receiver["parent"],"addChild",argument(icon.reference()));
      c.set(c.receiver,"currentEventcondId",id);c.set(c.receiver,"currentEventcondImg",image);
    }
    return done;
  }
  if(operation=="icons.end") {
    const auto icon=c.receiver["_eventconSprite"].reference();
    if(truth(icon)) { c.call(c.receiver["parent"],"removeChild",argument(icon.reference()));c.set(c.receiver,"_eventconSprite",Value{}); }
    return done;
  }
  if(operation=="icons.update") {
    invoke(c,"setupEventcon");const auto icon=c.receiver["_eventconSprite"].reference();
    if(truth(icon)) {
      const auto node=c.displayOf(icon);node->position={c.display->position.x,c.display->position.y-number(c.receiver["height"])};
      if(!truth(onCharacter(c,"isEventconPlaying")))invoke(c,"endEventcon");
    }
    return done;
  }
  if(operation=="omori.input") {
    const auto input=character(c)["_inputIcon"].reference();const auto existing=c.receiver["_inputIconSprite"].reference();
    if(truth(existing)) {
      const auto icon=sprite(c,existing);
      if(truth(input)) {
        if(icon->scale.x<1) { const double scale=icon->scale.x+0.1;icon->scale={scale,scale};c.set(input,"scale",scale); }
      } else if(icon->scale.x>0) { const double scale=std::max(icon->scale.x-0.1,0.0);icon->scale={scale,scale}; }
      else { c.call(c.receiver["parent"],"removeChild",argument(existing.reference()));c.set(c.receiver,"_inputIconSprite",Value{});return done; }
      icon->position={c.display->position.x,c.display->position.y-number(c.receiver["height"])-number(existing["height"])*icon->anchor.y};
    } else if(truth(input)) {
      const auto created=c.construct("Sprite_InputButton",{});c.set(c.receiver,"_inputIconSprite",created);
      const auto icon=sprite(c,created);const auto scale=input["scale"].reference();const double amount=scale.isUndefined() ? 0 : number(scale);
      icon->scale={amount,amount};icon->anchor={0.5,0.5};c.call(created,"activate",{});icon->z=7;c.call(c.receiver["parent"],"addChild",argument(created.reference()));
      icon->position={c.display->position.x,c.display->position.y-number(c.receiver["height"])-number(created["height"])*icon->anchor.y};
      c.call(created,truth(input["key"]) ? "setupKey" : "setupInput",{input["input"].reference()});
    }
    return done;
  }
  if(operation=="omori.shadow") {
    const auto data=character(c)["_shadow"].reference();auto value=c.receiver["_shadowSprite"].reference();
    if(truth(data)) {
      if(!truth(value)) {
        value=c.construct("Sprite",argument(c.receiver["bitmap"].reference()));c.set(c.receiver,"_shadowSprite",value);
        const auto shadow=sprite(c,value);shadow->anchor={0.5,1};shadow->setColorTone({-255,-255,-255,0});shadow->scale.x=-1;c.call(c.receiver,"addChild",argument(value.reference()));
      }
      const auto shadow=sprite(c,value);const auto frame=selfSprite(c).frame();shadow->setFrame(frame.x,frame.y,frame.width,frame.height);
      shadow->setOpacity(number(data["opacity"]));shadow->rotation=number(data["angle"])*std::acos(-1)/180;
      shadow->scale.y=number(data["scaleY"]);shadow->position={number(data["x"]),number(data["y"])};
    } else if(truth(value)) { c.call(c.receiver,"removeChild",argument(value.reference()));c.erase(c.receiver,"_shadowSprite"); }
    return done;
  }
  if(operation=="eventcon.update") {
    c.base(arguments);const double duration=number(c.receiver["_duration"]);
    if(duration>0) {
      c.set(c.receiver,"_duration",duration-1);
      if(duration-1>0)invoke(c,"updateFrame");else c.set(c.receiver,"_duration",4*number(invoke(c,"speed"))+number(invoke(c,"waitTime")));
    }
    return done;
  }
  if(operation=="eventcon.frame") {
    const double width=number(c.environment["iconParameters"]["EventconWidth"]),height=number(c.environment["iconParameters"]["EventconHeight"]);
    selfSprite(c).setFrame(number(invoke(c,"frameIndex"))*width,(number(c.receiver["_eventconId"])-1)*height,width,height);return done;
  }
  if(operation=="eventcon.speed")return c.environment["iconParameters"]["EventconSpeed"].reference();
  if(operation=="eventcon.wait")return c.environment["iconParameters"]["EventconWaitTime"].reference();
  if(operation=="eventcon.index")return 3-std::max(std::floor((number(c.receiver["_duration"])-number(invoke(c,"waitTime")))/number(invoke(c,"speed"))),0.0);
  if(operation=="input.activate") {c.set(c.receiver,"_active",true);return done;}
  if(operation=="input.reset") {c.set(c.receiver,"_iconFrame",0);c.set(c.receiver,"_iconFrameDelay",c.receiver["_iconFrameDelayMax"].reference());return done;}
  if(operation=="input.frame") {
    const auto& frame=c.receiver["_iconRects"][number(c.receiver["_iconFrame"])==0 ? "up" : "down"];
    selfSprite(c).setFrame(number(frame["x"]),number(frame["y"]),number(frame["width"]),number(frame["height"]));return done;
  }
  if(operation=="input.update") { c.base(arguments);if(truth(c.receiver["_active"]))invoke(c,"updateAnimation");return done; }
  if(operation=="input.animation") {
    const double delay=number(c.receiver["_iconFrameDelay"]);
    if(delay<=0) {
      c.set(c.receiver,"_iconFrame",std::fmod(number(c.receiver["_iconFrame"])+1,2));invoke(c,"refreshFrame");
      c.set(c.receiver,"_iconFrameDelay",c.receiver["_iconFrameDelayMax"].reference());
    } else c.set(c.receiver,"_iconFrameDelay",delay-1);
    return done;
  }
  throw std::invalid_argument("unknown character presentation operation: "+operation);
}
}
