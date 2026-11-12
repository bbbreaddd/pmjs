#include "mv_presentation.hpp"
#include <stdexcept>

namespace pmjs::mv {
void Presentation::clearMovie() {
  movieDecoder_.reset();
  if(movieImage_)core_.images().release(movieImage_);
  if(movieAudio_){core_.media().stop(movieAudio_);core_.media().release(movieAudio_);}
  movieImage_=0;movieAudio_=0;movieFile_.clear();
}
void Presentation::movie() {
  if(!session_.moviePlaying_) { if(movieDecoder_)clearMovie(); return; }
  if(!movieDecoder_||movieFile_!=session_.movieName_) {
    clearMovie();
    std::optional<std::filesystem::path> path;
    for(const char* suffix:{".webm",".mp4"}) {
      path=core_.vfs().resolve("movies/"+session_.movieName_+suffix);if(path)break;
    }
    if(!path)throw std::runtime_error("movie unavailable: "+session_.movieName_);
    movieDecoder_=std::make_unique<VideoDecoderSession>(*path);
    movieFile_=session_.movieName_;movieStarted_=session_.ticks_;
    if(!movieDecoder_->info().audioCodec.empty()) {
      std::string error;movieAudio_=core_.media().loadAudio(path->string(),&error);
      if(!movieAudio_)throw std::runtime_error("cannot open movie audio: "+error);
      core_.media().play(movieAudio_,false,0);
    }
  }
  const double timestamp=(session_.ticks_-movieStarted_)/60.0;
  std::string error;
  if(auto frame=movieDecoder_->frame(timestamp,&error)) {
    if(!movieImage_) {
      auto image=core_.images().createRgba(frame->width,frame->height,frame->rgba.data());
      if(!image)throw std::runtime_error("cannot create movie frame");movieImage_=image->handle;
    } else if(!core_.images().updateRgba(movieImage_,frame->rgba.data()))throw std::runtime_error("cannot update movie frame");
  }
  if(!error.empty())throw std::runtime_error("cannot decode movie: "+error);
  if(movieDecoder_->exhausted() && timestamp>=movieDecoder_->endTime()) {
    session_.moviePlaying_=false;clearMovie();return;
  }
  core_.renderer().queueQuad(0,0,core_.width(),core_.height(),{0,0,0,1});
  if(movieImage_) {
    const auto& info=movieDecoder_->info();
    quad(movieImage_,0,0,info.videoWidth,info.videoHeight,0,0,core_.width(),core_.height());
  }
}
}
