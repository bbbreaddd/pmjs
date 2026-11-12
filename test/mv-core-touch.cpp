#include "mv_core_input.hpp"
#include <iostream>
#include <sstream>
#include <stdexcept>
using pmjs::mv::core::TouchInput;
int main(int argc,char**)try{
  TouchInput touch;
  if(argc==1){
    touch.mouseDown(0,4,5,true,100);touch.update();
    if(!touch.isTriggered()||!touch.isRepeated()||touch.date()!=100)throw std::runtime_error("pointer press");
    touch.mouseUp(0,6,7);touch.update();
    if(touch.isPressed()||!touch.isReleased()||touch.isTriggered())throw std::runtime_error("pointer release");
    std::cout<<"native MV core pointer checks passed\n";return 0;
  }
  std::string line;
  while(std::getline(std::cin,line)){
    std::istringstream stream(line);std::string kind;stream>>kind;
    double x=0,y=0,now=0;int button=0;
    if(kind=="down"){stream>>button>>x>>y>>now;touch.mouseDown(button,x,y,x>=0&&y>=0&&x<100&&y<80,now);}
    else if(kind=="move"){stream>>x>>y;touch.mouseMove(x,y);}
    else if(kind=="up"){stream>>button>>x>>y;touch.mouseUp(button,x,y);}
    else if(kind=="wheel"){stream>>x>>y;touch.wheel(x,y);}
    else if(kind=="start"){
      int fingers,count;stream>>fingers>>count>>now;std::vector<std::array<double,2>> points;
      for(int i=0;i<count;i++){stream>>x>>y;points.push_back({x,y});}touch.touchStart(points,fingers,100,80,now);
    }else if(kind=="touchmove"){stream>>x>>y;touch.touchMove(x,y);}
    else if(kind=="end"){stream>>x>>y;touch.touchEnd(x,y);}
    else if(kind=="cancel")touch.touchCancel();
    else if(kind=="pointer"){bool type,primary;stream>>type>>primary>>x>>y;touch.pointerDown(type,primary,x,y,x>=0&&y>=0&&x<100&&y<80);}
    else if(kind=="clear")touch.clear();
    else if(kind=="repeat")stream>>touch.keyRepeatWait>>touch.keyRepeatInterval;
    else if(kind=="update"){
      touch.update();std::cout<<'['<<touch.isPressed()<<','<<touch.isTriggered()<<','<<touch.isRepeated()<<','<<touch.isLongPressed()<<','<<touch.isCancelled()<<','<<touch.isMoved()<<','<<touch.isReleased()<<','<<touch.x()<<','<<touch.y()<<','<<touch.wheelX()<<','<<touch.wheelY()<<','<<touch.date()<<"]\n";
    }else throw std::runtime_error("unknown pointer command");
    if(stream.fail())throw std::runtime_error("invalid pointer command: "+line);
  }
}catch(const std::exception& error){std::cerr<<error.what()<<'\n';return 1;}
