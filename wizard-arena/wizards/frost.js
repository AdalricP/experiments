// Season 1 finalist — forged by a Claude subagent over 10 generations.
// See fights/history.md for the full tournament story.
window.WIZARDS.push({
  "name": "Maelketh",
  "epithet": "the Riptide Executioner",
  "color": "#156b5a",
  "color2": "#5ff2d6",
  "element": "earth",
  "spells": [
    {
      "name": "Brinerot Hex",
      "desc": "Salt in the blood: a rangeless, unmissable, unreflectable 6dps rot that collapses fortresses from beyond any wall's reach.",
      "element": "neutral",
      "incantation": "/*Brinerot Hex: salt in the blood, rot in the vein. The sea needs no aim to drown a fortress.~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/ctx.curse(6,6);"
    },
    {
      "name": "Maelstrom Rend",
      "desc": "The signature execution: blink to contact from 158px, pay the red toll, and detonate a cascade of unmissable novas sealed with a shield-piercing strike \u2014 up to ~85 in one heartbeat.",
      "element": "neutral",
      "incantation": "/*Rend: the tide pays the red toll and detonates.*/var d=ctx.dist;if(d<162){if(d>14)ctx.blink(Math.cos(ctx.aim)*d,Math.sin(ctx.aim)*d);if(me.hp>(ctx.time>90?62:36)&&enemy.hp>20)ctx.sacrifice(16);ctx.leech(35,2.2);ctx.nova(30,40);ctx.nova(30,40);ctx.nova(ctx.budget()/1.41,40);if(me.stamina>60)ctx.strike(16)}else ctx.bolt(ctx.aim,{damage:14,speed:200,radius:3})"
    },
    {
      "name": "Kelpguard",
      "desc": "20 woven shield and closing salt-wounds \u2014 armor donned the moment before every crossing, never funded from the kill budget.",
      "element": "earth",
      "incantation": "/*Kelpguard: woven wrack and cold abyssal light knit over the skin, and the salt closes the wound.~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~*/ctx.shield(20);ctx.heal(7);"
    },
    {
      "name": "Undertow Step",
      "desc": "The wave is elsewhere: a 46px escape blink with mirror ward, haste, and a breath of shield for slipping a spent executioner's grasp.",
      "element": "earth",
      "incantation": "/*Undertow Step: the wave is elsewhere, and the sea gives back what is thrown at it.~*/ctx.blink(Math.cos(ctx.aim)*46,Math.sin(ctx.aim)*46);ctx.haste(40,1.5);ctx.reflect(0.8);ctx.shield(4);"
    }
  ],
  "policy": "var e=enemy,c=me.cooldowns,s=me.spellCosts,m=memory,M=me.mana,T=api.time,C=api.cast,Y=Math.hypot,dx=e.x-me.x,dy=e.y-me.y,d=Y(dx,dy)||1,t=api.threats[0],k=t&&t.dx*(me.y-t.y)-t.dy*(me.x-t.x)<0?-1:1;\nvar A=api.hazards[0],B=api.hazards[1],hz=A&&Y(e.x-A.x,e.y-A.y)<A.r+14||B&&Y(e.x-B.x,e.y-B.y)<B.r+14;\nvar vx=(e.x-(m.x||e.x))*4,vy=(e.y-(m.y||e.y))*4;m.x=e.x;m.y=e.y;\nd<158&&!hz&&c[1]<=0&&M>=s[1]?C(1):(me.hp<62||e.mana>24&&d<215&&me.shield<5)&&c[2]<=0&&M>=s[2]+s[1]?C(2):(T>4||e.mana<25)&&(d>85||c[1]>.3)&&c[0]<=0&&M>=s[0]+s[1]&&C(0);\n(d<55||me.slowed&&d<85)&&e.mana<25&&c[1]>.3&&c[3]<=0&&M>=s[3]+s[1]&&C(3,2*me.x-e.x,2*me.y-e.y);\nvar R=c[1]<.3&&M>=s[1]&&(me.shield>9||c[2]>.3||M<s[2]+s[1])?60:172;T>150&&(R=me.hp>e.hp+4?250:me.hp<=e.hp&&T>160?30:R);\nvar mx=dx/d*(d-R)/30+(240-me.x)/300,my=dy/d*(d-R)/30+(146-me.y)/300;\nt&&t.dist<90&&(mx=mx*.4-t.dy*k,my=my*.4+t.dx*k);\napi.move(mx,my)"
});
