#include "mv_engine.hpp"
#include "mv_core_types.hpp"
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <stdexcept>

namespace pmjs::mv {
namespace {
class Expression {
 public:
  struct Val {
    double num = 0;
    enum class Kind { num, nullVal, undefVal } kind = Kind::num;
    bool isNullish() const { return kind != Kind::num; }
    double toNum() const {
      if (kind == Kind::nullVal) return 0;
      if (kind == Kind::undefVal) return std::numeric_limits<double>::quiet_NaN();
      return num;
    }
    bool truth() const { return kind == Kind::num && num != 0 && !std::isnan(num); }
  };
  Expression(const std::string& source, const std::map<std::string,double>& fields, const FormulaResolver& resolver)
    : source_(source), fields_(fields), resolver_(resolver) {}
  double run() { auto result = conditional(true); space(); if (position_ != source_.size()) fail(); return result.toNum(); }
 private:
  [[noreturn]] void fail() const { throw std::invalid_argument("unsupported numeric expression at " + std::to_string(position_)); }
  void space() { while (position_ < source_.size() && std::isspace(static_cast<unsigned char>(source_[position_]))) ++position_; }
  bool take(const std::string& token) { space(); if (source_.compare(position_,token.size(),token)) return false; position_ += token.size(); return true; }
  static bool strictEq(const Val& a, const Val& b) {
    if (a.kind != b.kind) return false;
    if (a.kind != Val::Kind::num) return true;
    return a.num == b.num;
  }
  static bool looseEq(const Val& a, const Val& b) {
    if (a.isNullish() && b.isNullish()) return true;
    if (a.isNullish() || b.isNullish()) return false;
    return a.num == b.num;
  }
  Val conditional(bool active) {
    if (++depth_ > 128) fail();
    auto result = binary(0,active);
    if (take("?")) { auto yes = conditional(active && result.truth()); if (!take(":")) fail(); auto no = conditional(active && !result.truth()); result = result.truth() ? yes : no; }
    --depth_; return result;
  }
  Val binary(int level, bool active) {
    static const std::vector<std::vector<std::string>> operators{{"||"},{"&&"},{"|"},{"^"},{"&"},{"===","!==","==","!="},{"<=",">=","<",">"},{">>>","<<",">>"},{"+","-"},{"*","/","%"},{"**"}};
    if (level == static_cast<int>(operators.size())) return unary(active);
    Val left = binary(level+1,active);
    for (;;) {
      std::string op;
      space();
      for (const auto& candidate : operators[level]) {
        if (source_.compare(position_,candidate.size(),candidate)) continue;
        const char next = position_+candidate.size()<source_.size()?source_[position_+candidate.size()]:0;
        if ((candidate=="|" && next=='|') || (candidate=="&" && next=='&') || (candidate=="*" && next=='*') ||
            (candidate=="<" && next=='<') || (candidate==">" && next=='>')) continue;
        op=candidate; position_+=candidate.size(); break;
      }
      if(op.empty()) return left;
      const bool evaluateRight = active && !(op=="&&" && !left.truth()) && !(op=="||" && left.truth());
      const Val right = op=="**" ? binary(level,evaluateRight) : binary(level+1,evaluateRight);
      if(!active) { left={}; continue; }
      if(op=="&&") { left=left.truth()?right:left; continue; }
      if(op=="||") { left=left.truth()?left:right; continue; }
      if(op=="===") { left={strictEq(left,right)?1.0:0.0,Val::Kind::num}; continue; }
      if(op=="!==") { left={strictEq(left,right)?0.0:1.0,Val::Kind::num}; continue; }
      if(op=="==") { left={looseEq(left,right)?1.0:0.0,Val::Kind::num}; continue; }
      if(op=="!=") { left={looseEq(left,right)?0.0:1.0,Val::Kind::num}; continue; }
      const double ln = left.toNum(), rn = right.toNum();
      double out = ln;
      if(op=="+")out=ln+rn; else if(op=="-")out=ln-rn; else if(op=="*")out=ln*rn; else if(op=="/")out=ln/rn;
      else if(op=="%")out=std::fmod(ln,rn); else if(op=="**")out=std::pow(ln,rn);
      else if(op=="<")out=ln<rn; else if(op==">")out=ln>rn; else if(op=="<=")out=ln<=rn; else if(op==">=")out=ln>=rn;
      else {
        const auto a = int32(ln), b = int32(rn); const unsigned shift = static_cast<unsigned>(b)&31;
        if(op=="|")out=a|b; else if(op=="&")out=a&b; else if(op=="^")out=a^b;
        else if(op=="<<")out=static_cast<std::int32_t>(static_cast<std::uint32_t>(a)<<shift);
        else if(op==">>")out=a>>shift; else out=static_cast<std::uint32_t>(a)>>shift;
      }
      left={out,Val::Kind::num};
    }
  }
  static std::int32_t int32(double value) {
    if(!std::isfinite(value)||value==0)return 0;
    double n=std::fmod(std::trunc(value),4294967296.0); if(n<0)n+=4294967296.0;
    return static_cast<std::int32_t>(static_cast<std::uint32_t>(n));
  }
  Val unary(bool active) {
    if(take("!"))return {unary(active).truth()?0.0:1.0,Val::Kind::num};
    if(take("~"))return {static_cast<double>(~int32(unary(active).toNum())),Val::Kind::num};
    if(take("+"))return {unary(active).toNum(),Val::Kind::num};
    if(take("-"))return {-unary(active).toNum(),Val::Kind::num};
    return primary(active);
  }
  Val primary(bool active) {
    Val value=atom(active);
    while(take(".")) {
      space();
      std::string method;
      while(position_<source_.size() && (std::isalnum(static_cast<unsigned char>(source_[position_])) || source_[position_]=='_'))method+=source_[position_++];
      if(method!="clamp" && method!="mod")fail();
      if(!take("("))fail();
      std::vector<double> arguments;
      if(!take(")")){do{arguments.push_back(conditional(active).toNum());}while(take(","));if(!take(")"))fail();}
      if(!active){value={};continue;}
      const auto argument=[&](std::size_t index){return index<arguments.size()?arguments[index]:std::numeric_limits<double>::quiet_NaN();};
      value={method=="clamp"?core::clamp(value.toNum(),argument(0),argument(1)):core::mod(value.toNum(),argument(0)),Val::Kind::num};
    }
    return value;
  }
  Val atom(bool active) {
    if(take("(")) { auto value=conditional(active); if(!take(")"))fail(); return value; }
    space(); if(position_>=source_.size())fail();
    const char first=source_[position_];
    if(std::isdigit(static_cast<unsigned char>(first))||first=='.') {
      char* end=nullptr; const char* begin=source_.c_str()+position_; const double value=std::strtod(begin,&end);
      if(end==begin)fail(); position_+=end-begin; return {value,Val::Kind::num};
    }
    std::string name;
    while(position_<source_.size()) {
      char c=source_[position_]; if(!std::isalnum(static_cast<unsigned char>(c))&&c!='_'&&c!='$'&&c!='.')break;
      if(c=='.') {
        auto next=position_+1;
        while(next<source_.size()&&std::isspace(static_cast<unsigned char>(source_[next])))++next;
        const auto end=source_.find_first_not_of("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$",next);
        const auto member=source_.substr(next,end==std::string::npos?end:end-next);
        if(member=="clamp"||member=="mod")break;
      }
      name+=c; ++position_;
    }
    if(name.empty())fail();
    if(take("[")) { double index=conditional(active).toNum(); if(!take("]"))fail(); return {active?resolve(name+"[]",{index}):0,Val::Kind::num}; }
    if(take("(")) {
      std::vector<double> arguments;
      if(!take(")")) { do { arguments.push_back(conditional(active).toNum()); }while(take(",")); if(!take(")"))fail(); }
      return {active?resolve(name,arguments):0,Val::Kind::num};
    }
    if(!active)return {};
    if(name=="true")return {1,Val::Kind::num};
    if(name=="false")return {0,Val::Kind::num};
    if(name=="null")return {0,Val::Kind::nullVal};
    if(name=="undefined")return {0,Val::Kind::undefVal};
    if(name=="NaN")return {std::numeric_limits<double>::quiet_NaN(),Val::Kind::num};
    if(name=="Infinity")return {std::numeric_limits<double>::infinity(),Val::Kind::num};
    if(name=="Math.PI")return {3.14159265358979323846,Val::Kind::num};
    if(name=="Math.E")return {2.71828182845904523536,Val::Kind::num};
    auto it=fields_.find(name); return {it==fields_.end()?resolve(name,{}):it->second,Val::Kind::num};
  }
  double resolve(const std::string& name,const std::vector<double>& args) {
    auto arg=[&](std::size_t index) { return index<args.size()?args[index]:std::numeric_limits<double>::quiet_NaN(); };
    if(name=="Math.min") { double value=std::numeric_limits<double>::infinity(); for(double a:args)value=core::minimum(value,a);return value; }
    if(name=="Math.max") { double value=-std::numeric_limits<double>::infinity(); for(double a:args)value=core::maximum(value,a);return value; }
    if(name=="Math.abs")return std::abs(arg(0)); if(name=="Math.floor")return std::floor(arg(0));
    if(name=="Math.ceil")return std::ceil(arg(0));
    if(name=="Math.round")return core::round(arg(0));
    if(name=="Math.trunc")return std::trunc(arg(0)); if(name=="Math.sqrt")return std::sqrt(arg(0));
    if(name=="Math.pow")return std::pow(arg(0),arg(1)); if(name=="Math.exp")return std::exp(arg(0));
    if(name=="Math.log")return std::log(arg(0)); if(name=="Math.sin")return std::sin(arg(0));
    if(name=="Math.cos")return std::cos(arg(0)); if(name=="Math.tan")return std::tan(arg(0));
    if(name=="Math.sign")return std::isnan(arg(0))?arg(0):arg(0)>0?1:arg(0)<0?-1:arg(0);
    if(name=="Number"||name=="parseFloat")return arg(0); if(name=="parseInt")return std::trunc(arg(0));
    if(name=="isNaN"||name=="Number.isNaN")return std::isnan(arg(0));
    if(name=="isFinite"||name=="Number.isFinite")return std::isfinite(arg(0));
    if(resolver_)return resolver_(name,args);
    throw std::invalid_argument("unsupported expression symbol: "+name);
  }
  const std::string& source_; const std::map<std::string,double>& fields_; const FormulaResolver& resolver_;
  std::size_t position_=0; int depth_=0;
};
}
double formula(const std::string& expression,const std::map<std::string,double>& fields,const FormulaResolver& resolver) {
  return Expression(expression,fields,resolver).run();
}
double Session::evaluateExpression(const std::string& expression,const Battler* subject,const Battler* target) {
  std::map<std::string,double> fields;
  for(const auto& [name,battler]:std::vector<std::pair<std::string,const Battler*>>{{"a",subject},{"b",target}}) if(battler) {
    fields[name+".hp"]=battler->hp; fields[name+".mp"]=battler->mp; fields[name+".tp"]=battler->tp; fields[name+".level"]=battler->level;
    const std::vector<std::string> params{"mhp","mmp","atk","def","mat","mdf","agi","luk"};
    for(int i=0;i<8;++i)fields[name+"."+params[i]]=parameter(*battler,i);
    const std::vector<std::string> xparams{"hit","eva","cri","cev","mev","mrf","cnt","hrg","mrg","trg"};
    const std::vector<std::string> sparams{"tgr","grd","rec","pha","mcr","tcr","pdr","mdr","fdr","exr"};
    for(int i=0;i<10;++i) { fields[name+"."+xparams[i]]=trait(*battler,22,i,false); fields[name+"."+sparams[i]]=trait(*battler,23,i,true); }
  }
  return formula(expression,fields,[&](const std::string& name,const std::vector<double>& args)->double {
    if(name=="Math.random")return random();
    if(name=="Math.randomInt")return core::randomInt(args.empty()?std::numeric_limits<double>::quiet_NaN():args[0],[&]{return random();});
    const int first=args.empty()?0:static_cast<int>(args[0]);
    if(name=="v[]"||name=="$gameVariables.value")return variable(first).number();
    if(name=="$gameSwitches.value") { auto it=switches_.find(first);return it!=switches_.end()&&it->second; }
    if(name=="$gameParty.gold")return gold_; if(name=="$gameParty.size")return party_.size();
    if(name=="$gameParty.steps")return steps_; if(name=="$gameMap.mapId")return mapId_;
    if(name=="$gamePlayer.x")return player_.x; if(name=="$gamePlayer.y")return player_.y;
    if(name=="$gamePlayer.direction")return player_.direction;
    const Battler* value=name.starts_with("a.")?subject:name.starts_with("b.")?target:nullptr;
    if(value) {
      const auto method=name.substr(2);
      if(method=="param")return parameter(*value,first);
      if(method=="xparam")return trait(*value,22,first,false);
      if(method=="sparam")return trait(*value,23,first,true);
      if(method=="hpRate")return value->hp/std::max(1.0,parameter(*value,0));
      if(method=="mpRate"){const double mmp=parameter(*value,1);return mmp>0?value->mp/mmp:0.0;}
      if(method=="tpRate")return value->tp/100.0;
      if(method=="isActor")return !value->enemy; if(method=="isEnemy")return value->enemy;
      if(method=="isDead")return !value->hidden&&std::find(value->states.begin(),value->states.end(),1)!=value->states.end();
      if(method=="isAlive")return !value->hidden&&std::find(value->states.begin(),value->states.end(),1)==value->states.end();
      if(method=="isStateAffected")return std::find(value->states.begin(),value->states.end(),first)!=value->states.end();
      if(method=="isLearnedSkill")return value->skills.contains(first);
      if(method=="elementRate")return trait(*value,11,first,true);
      if(method=="stateRate")return trait(*value,13,first,true);
    }
    throw std::invalid_argument("unsupported native expression symbol: "+name);
  });
}
}
