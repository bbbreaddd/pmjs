#include "mv_tiled_map.hpp"
#include <cctype>
#include <cmath>
#include <sstream>
#include <stdexcept>

namespace pmjs::mv {
namespace {
int integer(const Value& value, int fallback=0) {
  if (std::holds_alternative<double>(value.data)) return value.integer(fallback);
  try {
    const auto text=value.text();const auto start=text.find_first_not_of(" \t\r\n");
    const auto digit=start==std::string::npos ? start : start+(text[start]=='+'||text[start]=='-');
    return std::stoi(text,nullptr,digit!=std::string::npos && (text.compare(digit,2,"0x")==0||text.compare(digit,2,"0X")==0) ? 16 : 10);
  } catch (const std::invalid_argument&) { return fallback; }
    catch (const std::out_of_range&) { return fallback; }
}
bool truth(const Value& value) {
  if (std::holds_alternative<std::string>(value.data)) return !value.text().empty();
  return value.boolean();
}
Value properties(const Value& value) {
  if (!std::holds_alternative<Value::Array>(value.data)) return value.reference();
  Value::Object result;
  for (const auto& item:value.array()) result[item["name"].text()]=item["value"];
  return result;
}
Value tileProperties(const Value& map, int gid) {
  for (const auto& set:map["tilesets"].array()) {
    const int first=set["firstgid"].integer();
    if (gid<first || gid>=first+set["tilecount"].integer()) continue;
    const auto key=std::to_string(gid-first);
    const auto& legacy=set["tileproperties"][key];
    if(!legacy.null())return legacy.reference();
    return properties(set["tiles"][key]["properties"]);
  }
  return Value::Object{};
}
int arrows(const Value& value) {
  int result=0;std::istringstream input(value.text());std::string word;
  while (std::getline(input,word,'&')) {
    const auto first=word.find_first_not_of(" \t\r\n"), last=word.find_last_not_of(" \t\r\n");
    if(first==std::string::npos)continue;
    word=word.substr(first,last-first+1);
    for(auto& c:word)c=static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    if(word=="down")result^=1;else if(word=="left")result^=2;else if(word=="right")result^=4;else if(word=="up")result^=8;
  }
  return result;
}
}

Value tiledReflections(const Value& areas, double x, double y) {
  Value::Array result;
  for (const auto& area:areas.array()) {
    const auto& rect=area["rect"];
    const bool inX=x>=rect["x"].number() && x<=rect["x"].number()+rect["width"].number();
    const bool inY=y>=rect["y"].number() && y<=rect["y"].number()+rect["height"].number();
    if(inX&&inY)result.push_back(area.reference());
  }
  return result;
}

void visitTiledCells(const Value& map, bool halfTile, const std::string& table,
    const std::function<void(int,int,int)>& write) {
  const int width=map["width"].integer(),height=map["height"].integer(),scale=halfTile?2:1;
  const int logicalWidth=width*scale;
  for(const auto& layer:(map["sourceLayers"].null()?map["layers"]:map["sourceLayers"]).array()) {
    if(layer["type"].text()=="objectgroup")continue;
    const auto props=properties(layer["properties"]);const auto kind=props["collision"].text();
    const bool collision=kind=="full"||kind=="tile-base"||kind=="up-left"||kind=="up-right"||kind=="down-left"||kind=="down-right";
    if(table=="collision"&&!collision)continue;
    if(table=="arrows"&&kind!="arrow"&&kind!="tile-base")continue;
    if(table=="regions"&&!truth(props["regionId"]))continue;
    if(table=="levelChanges"&&!truth(props["toLevel"]))continue;
    const int level=integer(props["level"]);write(level,-1,0);
    for(int cell=0;cell<width*height;++cell) {
      const int gid=layer["data"][cell].integer();
      const int base=(cell/width*scale)*logicalWidth+(cell%width*scale);
      if(table=="collision") {
        if(!gid)continue;
        if(kind=="full"||(kind=="tile-base"&&tileProperties(map,gid)["collision"].text()=="full")) {
          for(int dy=0;dy<scale;++dy)for(int dx=0;dx<scale;++dx)write(level,base+dy*logicalWidth+dx,1);
        } else if(kind!="tile-base")write(level,base+(kind=="up-right"||kind=="down-right"?1:0)+(kind=="down-left"||kind=="down-right"?logicalWidth:0),1);
        continue;
      }
      int value=0;
      if(table=="arrows") {
        const auto direction=kind=="tile-base"?tileProperties(map,gid)["arrowImpassable"]:props["arrowImpassable"];
        if((kind!="tile-base"&&!gid)||!truth(direction))continue;
        const int bits=arrows(direction);value=(bits&1?8:0)|(bits&2?1:0)|(bits&4)|(bits&8?2:0);
      } else if(table=="regions") {
        const auto region=props["regionId"].text()=="tile-base"?tileProperties(map,gid)["regionId"]:props["regionId"];
        if((props["regionId"].text()!="tile-base"&&!gid)||!truth(region))continue;
        value=integer(region);
      } else {
        if(!gid)continue;value=integer(props["toLevel"]);
      }
      for(int dy=0;dy<scale;++dy)for(int dx=0;dx<scale;++dx)write(level,base+dy*logicalWidth+dx,value);
    }
  }
}

Value tiledObjects(const Value& map,bool halfTile) {
  const int scale=halfTile?2:1;
  const double tw=map["tilewidth"].number()/scale,th=map["tileheight"].number()/scale;
  Value::Array reflections,events;
  for(const auto& layer:(map["sourceLayers"].null()?map["layers"]:map["sourceLayers"]).array()) {
    if(layer["type"].text()!="objectgroup")continue;
    const auto props=properties(layer["properties"]);
    for(const auto& object:layer["objects"].array()) {
      if(!props["reflectionCast"].null())reflections.emplace_back(Value::Object{
        {"rect",Value::Object{{"x",object["x"]},{"y",object["y"]},{"width",object["width"]},{"height",object["height"]}}},
        {"reflectionCast",props["reflectionCast"]},{"reflectionMask",props["reflectionMask"]},
        {"reflectionOpacity",truth(props["reflectionOpacity"])?props["reflectionOpacity"]:Value(255)},
        {"reflectionOffset",truth(props["reflectionOffset"])?props["reflectionOffset"]:Value(0)}});
      const auto objectProps=properties(object["properties"]);
      if(truth(objectProps["eventId"]))events.emplace_back(Value::Object{{"id",integer(objectProps["eventId"])},
        {"x",std::floor(object["x"].number()/tw)+(halfTile?1:0)},{"y",std::floor(object["y"].number()/th)+(halfTile?1:0)}});
    }
  }
  return Value::Object{{"reflectionAreas",std::move(reflections)},{"eventLocations",std::move(events)}};
}

Value compileTiledMap(const Value& map, bool halfTile) {
  const int scale=halfTile?2:1,width=map["width"].integer(),height=map["height"].integer();
  if(width<=0||height<=0||static_cast<std::int64_t>(width)*height*scale*scale>4194304)throw std::invalid_argument("invalid tiled map extent");
  const int logicalWidth=width*scale,logicalHeight=height*scale,size=logicalWidth*logicalHeight;
  const double tw=map["tilewidth"].number()/scale,th=map["tileheight"].number()/scale;
  if(tw<=0||th<=0)throw std::invalid_argument("invalid tiled tile dimensions");
  struct Level {Value::Array collision,arrows,regions,changes;};std::map<int,Level> levels;
  const auto levelFor=[&](int id)->Level& {
    auto [it,inserted]=levels.try_emplace(id);
    if(inserted)it->second={Value::Array(size,0),Value::Array(size,15),Value::Array(size,0),Value::Array(size,-1)};
    return it->second;
  };
  levelFor(0);
  for(const std::string name:{"collision","arrows","regions","levelChanges"})visitTiledCells(map,halfTile,name,[&](int id,int index,int value) {
    auto& level=levelFor(id);if(index<0)return;
    auto& values=name=="collision"?level.collision:name=="arrows"?level.arrows:name=="regions"?level.regions:level.changes;
    if(index>=static_cast<int>(values.size()))values.resize(index+1,Value::undefined());
    values[index]=name=="arrows"?values[index].integer()^value:value;
  });
  auto objects=tiledObjects(map,halfTile);
  Value::Object compiled;
  for(auto& [id,level]:levels) {
    Value::Array passage(size,0);
    for(int i=0;i<size;++i) {
      const int missing=15^level.arrows[i].integer();
      passage[i]=level.collision[i].integer()?15:(missing&1?2:0)|(missing&2?8:0)|(missing&4)|(missing&8?1:0);
    }
    compiled[std::to_string(id)]=Value::Object{{"collision",std::move(level.collision)},{"passage",std::move(passage)},
      {"arrows",std::move(level.arrows)},{"regions",std::move(level.regions)},{"levelChanges",std::move(level.changes)}};
  }
  return Value::Object{{"levels",std::move(compiled)},{"reflectionAreas",objects["reflectionAreas"]},{"eventLocations",objects["eventLocations"]},
    {"mapWidth",logicalWidth},{"mapHeight",logicalHeight},{"logicalTilewidth",tw},{"logicalTileheight",th},{"movementScale",48/std::min(tw,th)}};
}

int Session::tiledLevel() const { return tiledLevelVariable_ ? variable(tiledLevelVariable_).integer() : tiledCurrentLevel_; }
const Value& Session::tiledRoot(const std::string& name) const {
  static const Value empty=Value::undefined();const auto found=tiledTableRoots_.find(name);
  return found==tiledTableRoots_.end()?empty:found->second;
}
const Value& Session::tiledSource() const {
  const auto found=tiledSources_.find(mapId_);return found==tiledSources_.end()?tiledMapData(mapId_):found->second;
}
const Value& Session::tiledLevelData() const { return tiledMapData(mapId_)["levels"][std::to_string(tiledLevel())]; }
const Value& Session::tiledTable(const std::string& name,int level) const {
  const auto found=tiledTableRoots_.find(name);
  return found==tiledTableRoots_.end() ? tiledMapData(mapId_)["levels"][std::to_string(level)][name] : found->second[std::to_string(level)];
}

Value Session::invokeTiled(const std::string& method, const Value::Array& arguments) {
  if(method=="configure") {
    const auto& config=arguments.at(0);auto half=config["Half-tile movement"].text();
    for(auto& c:half)c=static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    tiledEnabled_=true;tiledHalfTile_=config["halfTile"].null() ? half=="true" : config["halfTile"].boolean();
    tiledLevelVariable_=integer(config[config["levelVariable"].null()?"Map Level Variable":"levelVariable"]);
    tiledCharacterZ_={integer(config[config["belowZ"].null()?"Z - Below Player":"belowZ"],1),
      integer(config[config["playerZ"].null()?"Z - Player":"playerZ"],3),integer(config[config["aboveZ"].null()?"Z - Above Player":"aboveZ"],5)};
    return Value::undefined();
  }
  if(method=="data")return tiledMapData(arguments.empty()?mapId_:arguments[0].integer()).reference();
  if(method=="objects")return tiledObjects(tiledSource(),tiledHalfTile_);
  if(method=="localLevel") {
    if(!arguments.empty())tiledCurrentLevel_=arguments[0].integer();
    return tiledCurrentLevel_;
  }
  if(method=="arrowBit") {
    const int bits=arrows(arguments.at(0));return (bits&1?8:0)|(bits&2?1:0)|(bits&4)|(bits&8?2:0);
  }
  if(method=="tileProperties")return tileProperties(tiledSource(),arguments.at(0).integer());
  if(method=="level") {
    if(!arguments.empty()) {
      if(tiledLevelVariable_) {
        const Value::Array values{tiledLevelVariable_,arguments[0]};
        dispatchGameDataMutation("variables","setValue",values);
      }
      else tiledCurrentLevel_=arguments[0].integer();
    }
    return tiledLevel();
  }
  if(method=="isHalfTile")return tiledHalfTile_;
  if(method=="isTiledMap")return tiledMapLoaded_;
  if(method=="unload") {tiledMapLoaded_=false;return Value::undefined();}
  if(method=="passable") {
    const int direction=arguments.at(2).integer();
    return tilePassage(arguments.at(0).integer(),arguments.at(1).integer(),(1<<(direction/2-1))&15);
  }
  if(method=="saveEventLocations")return truth(properties(tiledMapData(mapId_)["properties"])["saveEventLocations"]);
  if(method=="initialize") {
    setTiledMapData(mapId_,tiledMapData(mapId_).snapshot());
    tiledTableRoots_.clear();
    return Value::undefined();
  }
  if(method=="setupEvents") {
    const auto objects=tiledObjects(tiledSource(),tiledHalfTile_);
    const auto locations=objects["eventLocations"].snapshot();
    for(const auto& location:locations.array()) {
      auto event=std::find_if(events_.begin(),events_.end(),[&](const Event& value){return value.id==location["id"].integer();});
      if(event==events_.end())continue;
      const auto character=runtimeCharacter(event->id);const Value::Array position{location["x"],location["y"]};
      if(!runtimeHooks_ || !runtimeHooks_->characterMethod || !runtimeHooks_->characterMethod(character,"locate",position))
        runtimeCharacterCommand(character,"locate",position);
      if(runtimeHooks_ && runtimeHooks_->characterMethod)runtimeHooks_->characterMethod(character,"loadLocation",{});
    }
    return Value::undefined();
  }
  if(method=="width" || method=="height")return tiledMapData(mapId_)[method=="width" ? "mapWidth" : "mapHeight"];
  if(method=="region") {
    const int width=tiledMapData(mapId_)["mapWidth"].integer();
    const int index=arguments.at(0).integer()+width*arguments.at(1).integer();
    return index<0 ? Value::undefined() : tiledTable("regions",tiledLevel())[index];
  }
  if(method=="levelChange") {
    const int width=tiledMapData(mapId_)["mapWidth"].integer();
    const int index=arguments.at(0).integer()+width*arguments.at(1).integer();
    if(index<0 || tiledTable("levelChanges",tiledLevel())[index].number(-1)<0)return false;
    invokeTiled("level",{tiledTable("levelChanges",tiledLevel())[index]});return true;
  }
  if(method=="reflections"||method=="containsReflection") {
    const double x=arguments.at(0).number()*(arguments.size()==4 ? arguments.at(1).number() : 1);
    const double y=arguments.at(arguments.size()==4 ? 2 : 1).number()*(arguments.size()==4 ? arguments.at(3).number() : 1);
    if(method=="reflections")return tiledReflections(tiledMapData(mapId_)["reflectionAreas"],x,y);
    if(!tiledMapLoaded_)return false;
    for(const auto& area:tiledMapData(mapId_)["reflectionAreas"].array()) {
      const auto& rect=area["rect"];
      const bool inX=x>=rect["x"].number()&&x<=rect["x"].number()+rect["width"].number();
      const bool inY=y>=rect["y"].number()&&y<=rect["y"].number()+rect["height"].number();
      if(inX&&inY)return true;
    }
    return false;
  }
  if(method=="bindReflections") {
    if(tiledMapData(mapId_).null())return Value::undefined();
    std::get<Value::Object>(runtimeTiledMaps_.at(mapId_).data)["reflectionAreas"]=arguments.at(0).reference();
    return Value::undefined();
  }
  if(method=="bindTables") { tiledTableRoots_[arguments.at(0).text()]=arguments.at(1).reference();return Value::undefined(); }
  if(method=="bindSource") { tiledSources_[arguments.at(0).integer()]=arguments.at(1).reference();return Value::undefined(); }
  if(method=="table"&&arguments.size()==2)return tiledTable(arguments[0].text(),arguments[1].integer()).reference();
  throw std::invalid_argument("unknown tiled operation: "+method);
}
}
