#pragma once

#include "../../src/mv_engine.hpp"
#include "../../src/mv_core_display.hpp"

namespace pmjs::mv::omori {
struct CharacterPresentationContext {
  Session& session;
  Value receiver;
  std::shared_ptr<RuntimeCharacter> entity;
  Value environment;
  std::shared_ptr<core::Container> display;
  CharacterPresentationContext(Session& value,Value object,std::shared_ptr<RuntimeCharacter> character,Value globals,std::shared_ptr<core::Container> node)
    :session(value),receiver(std::move(object)),entity(std::move(character)),environment(std::move(globals)),display(std::move(node)) {}
  virtual ~CharacterPresentationContext()=default;
  virtual Value characterData()=0;
  virtual Value call(const Value&,const std::string&,const Value::Array&)=0;
  virtual Value base(const Value::Array&)=0;
  virtual Value construct(const std::string&,const Value::Array&)=0;
  virtual void set(const Value&,const std::string&,const Value&)=0;
  virtual void erase(const Value&,const std::string&)=0;
  virtual std::shared_ptr<core::Container> displayOf(const Value&)=0;
};

bool hasCharacterPresentationOperation(const std::string& operation);
using CharacterPresentationQuery=Value (*)(Session&,const Value::Array&);
CharacterPresentationQuery findCharacterPresentationQuery(const std::string& operation);
Value invokeCharacterPresentation(const std::string& operation,CharacterPresentationContext& context,const Value::Array& arguments);
}
