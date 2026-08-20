// Externalised from an inline <script> block in index.html (AS-02).
// Inline scripts are why the CSP needed `script-src 'unsafe-inline'`, which is the directive
// that lets an INJECTED <script> tag execute. Served from this file, `'self'` covers it.
// Loaded at the SAME position in the document with the same attributes (none), so
// execution order, timing and global scope are unchanged. Do NOT add defer/async.

(function(){
          var vp=document.getElementById('showcaseCarousel'); if(!vp) return;
          var slides=vp.querySelectorAll('.carousel-slide');
          var dots=document.querySelectorAll('#showcaseDots .carousel-dot');
          var i=0,timer=null,DELAY=5000;
          function go(n){slides[i].classList.remove('active');if(dots[i])dots[i].classList.remove('active');i=(n+slides.length)%slides.length;slides[i].classList.add('active');if(dots[i])dots[i].classList.add('active');}
          function next(){go(i+1);}
          function start(){stop();timer=setInterval(next,DELAY);}
          function stop(){if(timer){clearInterval(timer);timer=null;}}
          dots.forEach(function(d,n){d.addEventListener('click',function(){go(n);start();});});
          vp.addEventListener('mouseenter',stop);vp.addEventListener('mouseleave',start);
          start();
        })();
