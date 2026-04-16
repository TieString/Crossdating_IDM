使用 scrollbar-gutter CSS 属性解决由滚动条引起的不必要的布局偏移
2021-12-08
4,791
阅读3分钟
原文地址：使用 scrollbar-gutter CSS 属性解决由滚动条引起的不必要的布局偏移
作者：adajuly
前言

当我们在web页面上显示滚动条的时候，会有一个问题就是滚动条展示的时候会影响到我们页面的布局，scrollbar-gutter CSS属性可以帮开发人员更好的解决这个问题。

接下来我们一起看下怎么解决~

👨‍🔬 本文中描述的 CSS 功能目前仅在 Chromium 88+ 中支持，并且通过 chrome://flags 启用了 #experimental-web-platform-features 标志。
💥 为了保证 Chromium 安装干净，建议您不要在 Chromium Stable 中设置此标志，建议使用 Beta / Canary 版本。

正文

Classic vs Overlay Scrollbars
在我们开始之前，我们先来区分两种类型的滚动条：经典滚动条和覆盖滚动条。

Classic Scrollbars：经典滚动条是放置在所谓的“Scrollbar Gutter”中的滚动条。 Scrollbar Gutter 是内边框边缘和外填充边缘之间的空间。对于经典滚动条，Scrollbar Gutter 的大小与滚动条的宽度相同。这些滚动条通常是不透明的，并从相邻的内容中占用一些空间。

图解：经典滚动条是从相邻内容中占用了一些空间。

Overlay Scrollbars：覆盖滚动条是那些放置在内容上的 iOS/macOS 风格的滚动条。它们默认是不显示的，仅在用户滚动时显示。为了保持滚动条下面的内容可见，因此滚动条是半透明的，滚动条样式取决于当前浏览器来确定，滚动条的大小也可能会有所不同。
image
图解：覆盖滚动条是放置在内容上的。

🍏 macOS 的用户可以通过系统偏好设置从覆盖切换到经典滚动条~

问题
当页面结构框的内容变得太大时（例如当它溢出时），默认情况下浏览器将显示一个滚动条。在经典滚动条的情况下，这有一个令人讨厌的副作用：由于滚动条需要一些空间，内容的可用宽度会缩小，因此布局也会发生变化。

image
当内容增加时，滚动条就会出现了！

☝️ 当设置成覆盖滚动条时，就不会有布局转换，因为这些滚动条会在内容上呈现。

解决方案
scrollbar-gutter: stable 就可以解决上述问题 ……

通过将 scrollbar-gutter 设置为 stable 我们可以让 UA 始终显示 Scrollbar Gutter。当结构框中的内容没有溢出时则不显示滚动条。这样我们就有了一个视觉上稳定的布局：当盒子开始溢出时，滚动条将被渲染，但不会发生布局移位，因为这时它的空间已经被保留了。

image
图解：当滚动条显示时，内容不会移动，因为浏览器已经为滚动条装订线保留了空间。

需要注意的是，scrollbar-gutter 属性对滚动条本身的渲染没有影响——它只影响 gutter 的渲染。滚动条的呈现是通过溢出属性控制。

scrollbar-gutter 的默认值是 auto，设置为auto后，行为与问题中描述的行为没有变化。

scrollbar-gutter: stable both-edges可以设置布局两端对齐。

image
图解：滚动条显示的时候，内容也不会移动。除此之外，在相对的边缘也保留了相同的相同宽度的空间。

注意事项
对于 overflow属性， scrollbar-gutter是通过将滚动条应用于视口替代在根元素上设置滚动条。
与 overflow 属性不同，浏览器不会从 HTML body 元素传播 scrollbar-gutter。
浏览器支持
supportbrowser.jpg

总结
使用 scrollbar-gutter 我们可以防止由滚动条引起的一些不必要的布局更改。

下图总结了本文中涵盖的场景：

111111111.jpg