#include "mv_window_bindings.hpp"
#include <type_traits>
#include <cmath>
#include <limits>

namespace pmjs::mv {
namespace {
template<class T> Value windowOperation(Window_Base& base,Session& session,const std::string& method,const Value::Array& values) {
  auto& window=dynamic_cast<T&>(base);
  const auto value=[&](std::size_t index) -> Value { return index<values.size() ? values[index] : Value{}; };
  if (method=="geometry") return Value::Array{window.rect.x,window.rect.y,window.rect.width,window.rect.height};
  if (method=="maxItems") { if constexpr (std::is_base_of_v<Window_Selectable,T>) return window.maxItems(); }
  if (method=="itemHeight") { if constexpr (std::is_base_of_v<Window_Selectable,T>) return window.itemHeight(); }
  if (method=="maxCols") { if constexpr (std::is_base_of_v<Window_Selectable,T>) return window.maxCols; }
  if (method=="isCurrentItemEnabled") { if constexpr (std::is_base_of_v<Window_Selectable,T>) return window.isCurrentItemEnabled(); }
  if (method=="makeCommandList") {
    if constexpr (requires { window.makeCommandList(session); }) window.makeCommandList(session);
    else if constexpr (requires { window.makeCommandList(session,true); }) window.makeCommandList(session,session.battle().canEscape);
    else throw std::invalid_argument("native command list has no default producer");
    return Value::undefined();
  }
  if (method=="refreshModel") {
    if constexpr (requires { window.refresh(session); }) window.refresh(session);
    else if constexpr (requires { window.refresh(&session); }) window.refresh(&session);
    return Value::undefined();
  }
  if (method=="data") {
    if constexpr (requires { window.data; }) {
      if (!values.empty()) {
        const auto replacementValue = value(0);
        if (!std::holds_alternative<Value::Array>(replacementValue.data)) throw std::invalid_argument("window data requires an array");
        std::vector<int> replacement;
        for (const auto& entry : replacementValue.array()) {
          const double id = entry.number(-1);
          if (!std::isfinite(id) || id < 0 || id > std::numeric_limits<int>::max() || std::floor(id) != id) throw std::invalid_argument("window data requires nonnegative integer IDs");
          replacement.push_back(static_cast<int>(id));
        }
        window.data = std::move(replacement);
      }
      Value::Array data; for (auto id:window.data) data.emplace_back(id); return data;
    }
  }
  if (method=="drawItem" || method=="drawContent") {
    const int index=value(0).integer(),width=window.contentsWidth();
    const int y=std::is_base_of_v<Window_Selectable,T> ? index*window.lineHeight() : 0;
    if constexpr (std::is_base_of_v<Window_MenuStatus,T>) {
      if (index>=0 && index<int(window.actorIds.size())) {
        const auto id=window.actorIds[index]; const auto actor=session.actors().find(id);
        if (actor!=session.actors().end()) window.drawActorSimpleStatus(actor->second,session,0,y,width);
      }
    } else if constexpr (requires { window.data; }) {
      if (index>=0 && index<int(window.data.size())) {
        const int id=window.data[index];
        if constexpr (std::is_base_of_v<Window_SkillList,T>) window.drawItemName(session.database()["skills"][id],0,y,width);
        else window.drawItemName(session.database()[id/100000==1 ? "weapons" : id/100000==2 ? "armors" : "items"][id%100000],0,y,width);
      }
    } else if constexpr (requires { window.actorId; }) {
      const auto actor=session.actors().find(window.actorId);
      if (actor!=session.actors().end()) window.drawActorSimpleStatus(actor->second,session,0,0,width);
    } else if constexpr (std::is_same_v<T,Window_Gold>) {
      window.drawCurrencyValue(session.gold(),session.database()["system"]["currencyUnit"].text(),0,0,width);
    } else if constexpr (std::is_same_v<T,Window_NumberInput>) { window.refresh();
    } else if constexpr (std::is_same_v<T,Window_MapName>) {
      window.mapName=session.invokeGameDataBase("map","displayName",{}).text(); window.refresh();
    } else if constexpr (std::is_same_v<T,Window_Help>) window.drawText(window.text,0,0,width);
    else if constexpr (std::is_base_of_v<Window_Command,T>) {
      if (index>=0 && index<int(window.commands.size())) window.drawText(window.commands[index].name,0,y,width);
    } else throw std::invalid_argument("native window drawing method is not bound: "+std::string(typeid(T).name()));
    return Value::undefined();
  }
  if constexpr (std::is_same_v<T,Window_ShopBuy>) {
    if (method == "shopItem") {
      const int index = value(0).integer();
      if (index < 0 || index >= static_cast<int>(window.goods.size())) return Value{};
      return Value::Array{window.goods[index].kind, window.goods[index].id};
    }
    if (method == "priceForItem") {
      for (std::size_t index = 0; index < window.goods.size(); ++index)
        if (window.goods[index].kind == value(0).integer() && window.goods[index].id == value(1).integer()) return window.goods[index].price;
      return 0;
    }
  }
  if constexpr (std::is_same_v<T,Window_EquipSlot>) {
    if (method == "actorId") { if (!values.empty()) window.setActor(value(0).integer(), session); return window.actorId; }
  }
#define FIELD(Name) \
  if (method==#Name) { if constexpr (requires { window.Name; }) { \
    using Field=std::remove_cvref_t<decltype(window.Name)>; \
    if constexpr (std::is_arithmetic_v<Field> || std::is_same_v<Field,std::string>) { \
      if (!values.empty()) { if constexpr (std::is_same_v<Field,std::string>) window.Name=value(0).text(); else if constexpr (std::is_same_v<Field,bool>) window.Name=value(0).boolean(); else window.Name=static_cast<Field>(value(0).number()); } \
      return Value(window.Name); \
    } \
  } }
  FIELD(actorId) FIELD(slotId) FIELD(skillType) FIELD(category) FIELD(pendingIndex) FIELD(formationMode)
  FIELD(number) FIELD(max) FIELD(price) FIELD(maxDigits) FIELD(money) FIELD(purchaseOnly)
  FIELD(mode) FIELD(topId) FIELD(name) FIELD(index) FIELD(text)
#undef FIELD
  throw std::invalid_argument("native window method is not bound: "+method);
}
template<class T,class Factory> WindowBinding describe(const char* name,const char* parent,int arguments,Factory create) {
  WindowBinding binding{name,parent,arguments,{},std::is_base_of_v<Window_Selectable,T>,std::is_base_of_v<Window_Command,T>,false,create,windowOperation<T>};
#define FIELD(Name) if constexpr (requires(T value) { value.Name; }) { using Field=std::remove_cvref_t<decltype(std::declval<T>().Name)>; if constexpr (std::is_arithmetic_v<Field> || std::is_same_v<Field,std::string>) binding.fields.push_back(#Name); }
  FIELD(actorId) FIELD(slotId) FIELD(skillType) FIELD(category) FIELD(pendingIndex) FIELD(formationMode)
  FIELD(number) FIELD(max) FIELD(price) FIELD(maxDigits) FIELD(money) FIELD(purchaseOnly)
  FIELD(mode) FIELD(topId) FIELD(name) FIELD(text)
#undef FIELD
  if constexpr (requires(T value) { value.data; }) binding.data=true;
  return binding;
}
int integer(const Value::Array& values,std::size_t index,int fallback=0) { return index<values.size() ? values[index].integer(fallback) : fallback; }
}
const std::vector<WindowBinding>& windowBindings() {
  static const std::vector<WindowBinding> bindings{
#define WINDOW0(Type,Parent) describe<Type>(#Type,#Parent,0,[](Session&,const Value::Array&) { return std::make_shared<Type>(); }),
#define WINDOWXY(Type,Parent) describe<Type>(#Type,#Parent,2,[](Session&,const Value::Array& v) { return std::make_shared<Type>(integer(v,0),integer(v,1)); }),
#define WINDOW4(Type,Parent) describe<Type>(#Type,#Parent,4,[](Session& s,const Value::Array& v) { return std::make_shared<Type>(integer(v,0),integer(v,1),integer(v,2,s.screenWidth()),integer(v,3,s.screenHeight())); }),
    WINDOWXY(Window_MenuStatus,Window_Selectable)
    WINDOW0(Window_MenuActor,Window_MenuStatus)
    WINDOW0(Window_ItemCategory,Window_HorzCommand)
    WINDOWXY(Window_SkillType,Window_Command)
    WINDOW4(Window_ItemList,Window_Selectable)
    WINDOW4(Window_SkillList,Window_Selectable)
    WINDOW4(Window_SkillStatus,Window_Base)
    WINDOW4(Window_EquipSlot,Window_Selectable)
    WINDOWXY(Window_EquipStatus,Window_Base)
    WINDOW4(Window_EquipItem,Window_ItemList)
    WINDOW0(Window_Status,Window_Selectable)
    WINDOW4(Window_SavefileList,Window_Selectable)
    WINDOW4(Window_ShopSell,Window_ItemList)
    WINDOW4(Window_ShopStatus,Window_Base)
    WINDOW0(Window_NameInput,Window_Selectable)
    WINDOW0(Window_ChoiceList,Window_Command)
    WINDOW0(Window_NumberInput,Window_Selectable)
    WINDOW0(Window_EventItem,Window_ItemList)
    WINDOW0(Window_ScrollText,Window_Base)
    WINDOW0(Window_PartyCommand,Window_Command)
    WINDOW0(Window_ActorCommand,Window_Command)
    WINDOW4(Window_BattleStatus,Window_Selectable)
    WINDOW4(Window_BattleLog,Window_Base)
    WINDOWXY(Window_BattleActor,Window_BattleStatus)
    WINDOWXY(Window_BattleEnemy,Window_Selectable)
    WINDOW4(Window_BattleSkill,Window_SkillList)
    WINDOW4(Window_BattleItem,Window_ItemList)
    WINDOW0(Window_GameEnd,Window_Command)
    WINDOWXY(Window_DebugRange,Window_Selectable)
    WINDOW4(Window_HorzCommand,Window_Command)
    WINDOW0(Window_MapName,Window_Base)
    WINDOWXY(Window_Gold,Window_Base)
#undef WINDOW0
#undef WINDOWXY
#undef WINDOW4
    describe<Window_Help>("Window_Help","Window_Base",1,[](Session&,const Value::Array& v) { return std::make_shared<Window_Help>(integer(v,0,2)); }),
    describe<Window_EquipCommand>("Window_EquipCommand","Window_HorzCommand",3,[](Session& s,const Value::Array& v) { return std::make_shared<Window_EquipCommand>(integer(v,0),integer(v,1),integer(v,2,s.screenWidth())); }),
    describe<Window_DebugEdit>("Window_DebugEdit","Window_Selectable",3,[](Session& s,const Value::Array& v) { return std::make_shared<Window_DebugEdit>(integer(v,0),integer(v,1),integer(v,2,s.screenWidth())); }),
    describe<Window_ShopCommand>("Window_ShopCommand","Window_HorzCommand",2,[](Session& s,const Value::Array& v) { return std::make_shared<Window_ShopCommand>(integer(v,0,s.screenWidth()),v.size()>1 && v[1].boolean()); }),
    describe<Window_ShopNumber>("Window_ShopNumber","Window_Selectable",3,[](Session& s,const Value::Array& v) { return std::make_shared<Window_ShopNumber>(integer(v,0),integer(v,1),integer(v,2,s.screenHeight())); }),
    describe<Window_ShopBuy>("Window_ShopBuy","Window_Selectable",4,[](Session& s,const Value::Array& v) {
      std::vector<ShopGood> goods;
      if (v.size()>3) for (const auto& good:v[3].array()) goods.push_back({good[0].integer(),good[1].integer(),good[2].integer()==1 ? good[3].integer() : -1});
      return std::make_shared<Window_ShopBuy>(integer(v,0),integer(v,1),integer(v,2,s.screenHeight()),std::move(goods));
    }),
    describe<Window_NameEdit>("Window_NameEdit","Window_Base",3,[](Session&,const Value::Array& v) { return std::make_shared<Window_NameEdit>(integer(v,0),integer(v,1,12),v.size()>2 ? v[2].text() : ""); })
  };
  return bindings;
}
}
