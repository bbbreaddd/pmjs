#include "mv_engine.hpp"
#include <algorithm>
#include <cctype>
#include <regex>
#include <stdexcept>

namespace pmjs::mv {
namespace {
std::string trim(std::string text) {
  const auto first=text.find_first_not_of(" \t\r\n"),last=text.find_last_not_of(" \t\r\n");
  return first==std::string::npos?std::string{}:text.substr(first,last-first+1);
}
std::vector<std::string> split(const std::string& text,char delimiter) {
  std::vector<std::string> result; std::size_t start=0; int depth=0; char quote=0; bool escape=false;
  for(std::size_t i=0;i<text.size();++i) {
    const char c=text[i];
    if(quote) { if(escape)escape=false;else if(c=='\\')escape=true;else if(c==quote)quote=0; continue; }
    if(c=='\''||c=='"'){quote=c;continue;}
    if(c=='('||c=='['||c=='{')++depth;
    else if(c==')'||c==']'||c=='}')--depth;
    else if(c==delimiter&&depth==0) { result.push_back(trim(text.substr(start,i-start)));start=i+1; }
  }
  if(quote||depth)throw std::invalid_argument("unbalanced native script expression");
  if(start<text.size())result.push_back(trim(text.substr(start)));
  return result;
}
}
void Session::executeNativeScript(const std::string& source,Interpreter& context) {
  for(auto statement:split(source,';')) {
    statement=trim(statement); if(statement.empty())continue;
    const auto open=statement.find('('),close=statement.rfind(')');
    if(open==std::string::npos||close==std::string::npos||!trim(statement.substr(close+1)).empty()) {
      evaluateExpression(statement);continue;
    }
    std::smatch actorCall;
    static const std::regex actorPattern(R"(^\$gameActors\.actor\((.+)\)\.([A-Za-z]+)\((.*)\)$)");
    if(std::regex_match(statement,actorCall,actorPattern)) {
      const int id=static_cast<int>(evaluateExpression(actorCall[1].str()));
      if(database_["actors"][id].null())continue;
      if(!actors_.contains(id))initializeActor(id);
      auto& actor=actors_.at(id); const auto args=split(actorCall[3].str(),',');
      const auto number=[&](std::size_t i){return i<args.size()?evaluateExpression(args[i]):0;};
      const auto method=actorCall[2].str();
      if(method=="setHp")actor.hp=static_cast<int>(number(0));
      else if(method=="setMp")actor.mp=static_cast<int>(number(0));
      else if(method=="setTp")actor.tp=static_cast<int>(number(0));
      else if(method=="gainHp")actor.hp+=static_cast<int>(number(0));
      else if(method=="gainMp")actor.mp+=static_cast<int>(number(0));
      else if(method=="gainTp")actor.tp+=static_cast<int>(number(0));
      else if(method=="recoverAll")recover(actor);
      else if(method=="addState")addState(actor,static_cast<int>(number(0)));
      else if(method=="removeState")removeState(actor,static_cast<int>(number(0)));
      else if(method=="learnSkill")actor.skills.insert(static_cast<int>(number(0)));
      else if(method=="forgetSkill")actor.skills.erase(static_cast<int>(number(0)));
      else if(method=="changeExp")changeActorExp(actor,number(0),number(1)!=0);
      else throw std::invalid_argument("unsupported native actor script call: "+method);
      refreshBattler(actor); continue;
    }
    const auto name=trim(statement.substr(0,open)); const auto args=split(statement.substr(open+1,close-open-1),',');
    const auto number=[&](std::size_t i){return i<args.size()?evaluateExpression(args[i]):0;};
    const auto value=[&](std::size_t i)->Value {
      if(i>=args.size())return {};
      const auto& text=args[i];
      if(text.size()>=2&&(text.front()=='\''||text.front()=='"')&&text.back()==text.front())return text.substr(1,text.size()-2);
      if(text=="true")return true;if(text=="false")return false;
      return evaluateExpression(text);
    };
    if(context.scriptCharacter && name.starts_with("this.")) {
      auto* character=routeCharacter(*context.scriptCharacter,context); if(!character)continue;
      const auto method=name.substr(5);
      const int first=static_cast<int>(number(0));
      if(method=="setDirection") {if(!character->directionFix&&first)character->direction=first;character->stopCount=0;}
      else if(method=="setMoveSpeed")character->moveSpeed=first;
      else if(method=="setMoveFrequency")character->moveFrequency=first;
      else if(method=="setPattern")character->pattern=first;
      else if(method=="setOpacity")character->opacity=first;
      else if(method=="setBlendMode")character->blendMode=first;
      else if(method=="setThrough")character->through=value(0).boolean();
      else if(method=="setTransparent")character->transparent=value(0).boolean();
      else if(method=="setWalkAnime")character->walkAnime=value(0).boolean();
      else if(method=="setStepAnime")character->stepAnime=value(0).boolean();
      else if(method=="setDirectionFix")character->directionFix=value(0).boolean();
      else if(method=="setImage"){character->characterName=value(0).text();character->characterIndex=static_cast<int>(number(1));character->tileId=0;}
      else if(method=="moveStraight")move(*character,first);
      else if(method=="moveForward")move(*character,character->direction);
      else if(method=="moveBackward") {const bool fixed=character->directionFix;character->directionFix=true;move(*character,10-character->direction);character->directionFix=fixed;}
      else if(method=="turn180"){if(!character->directionFix)character->direction=10-character->direction;character->stopCount=0;}
      else if(method=="locate"||method=="setPosition") {character->x=roundMapX(first);character->y=roundMapY(static_cast<int>(number(1)));character->realX=character->x;character->realY=character->y;}
      else throw std::invalid_argument("unsupported native character script call: "+method);
      continue;
    }
    if(name=="$gameVariables.setValue")operateVariable(static_cast<int>(number(0)),0,value(1));
    else if(name=="$gameSwitches.setValue") { switches_[static_cast<int>(number(0))]=value(1).boolean();refreshNeeded_=true; }
    else if(name=="$gameTemp.reserveCommonEvent")reservedCommonEvent_=static_cast<int>(number(0));
    else if(name=="$gameParty.gainGold"||name=="$gameParty.loseGold")gold_=static_cast<int>(std::clamp(gold_+(name.ends_with("loseGold")?-1:1)*number(0),0.0,99999999.0));
    else if(name=="$gameTimer.start") {timerFrames_=static_cast<int>(number(0));timerWorking_=true;}
    else if(name=="$gameTimer.stop")timerWorking_=false;
    else if(name=="this.wait")context.wait=static_cast<int>(number(0));
    else if(name=="this.setWaitMode") {
      const auto mode=value(0).text();
      if(mode=="scroll")context.waitingScroll=true;else if(mode=="gather")context.waitingGather=true;
      else if(mode=="action")context.waitingAction=true;else if(!mode.empty())throw std::invalid_argument("unsupported native script wait: "+mode);
    }
    else if(name=="$gameScreen.startFadeOut") {fadeOut_=static_cast<int>(number(0));}
    else if(name=="$gameScreen.showPicture") {
      Value::Array p{static_cast<int>(number(0)),value(1),static_cast<int>(number(2)),0,value(3),value(4),value(5),value(6),value(7),value(8)};
      screenEventCommand(Value::Object{{"code",231},{"parameters",p}},context);
    }
    else if(name=="$gameScreen.erasePicture")screenEventCommand(Value::Object{{"code",235},{"parameters",Value::Array{value(0)}}},context);
    else if(name=="SceneManager.goto") {
      if(args.empty())throw std::invalid_argument("missing native scene");
      if(args[0]=="Scene_Title")openTitle();else if(args[0]=="Scene_Gameover")openGameOver();
      else if(args[0]=="Scene_Map"){ui_={};ui_.scene=Scene::map;}
      else throw std::invalid_argument("unsupported native script scene: "+args[0]);
    }
    else evaluateExpression(statement);
  }
}
}
